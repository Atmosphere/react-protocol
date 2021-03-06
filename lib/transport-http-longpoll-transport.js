/*
 * Vibe
 * http://vibe-project.github.io/projects/vibe-protocol/
 * 
 * Copyright 2014 The Vibe Project 
 * Licensed under the Apache License, Version 2.0
 * http://www.apache.org/licenses/LICENSE-2.0
 */
var events = require("events");
var url = require("url");
var http = require("http");
var createHttpBaseTransport = require("./transport-http-base-transport");

http.globalAgent.maxSockets = Infinity;

// This function is exposed to the module's `transport` module's
// `createHttpLongpollTransport` as a factory to create a HTTP long
// polling transport. In long polling, the client performs a HTTP persistent
// connection and the server ends the response with message. Then, the client
// receives it and performs a request again and again.
module.exports = function(uri, options) {
    var urlObj = url.parse(uri, true);
    // URI's protocol should be either `http` or `https` and transport param
    // should be `longpoll`.
    if ((urlObj.protocol === "http:" || urlObj.protocol === "https:") && urlObj.query.transport === "longpoll") {
        // A transport object.
        var self = createHttpBaseTransport(uri, options);
        // Any error on request-response should propagate to transport.
        function onerror(error) {
            self.emit("error", error);
        }
        // If the underlying connection of request-response was closed, fires
        // `close` event.
        function onclose() {
            self.emit("close");
        }

        // The current holding request.
        var req;
        self.connect = function() {
            // Performs a HTTP persistent connection through `GET` method. The
            // first request's `when` param should be `open`. In case of JSONP,
            // `jsonp` param should be `true` and `callback` param should be
            // provided as well.
            req = http.get(uri + "&when=open")
            .on("error", onerror).on("close", onclose)
            .on("response", function(res) {
                // Aggregates chunks to make a complete response body.
                var body = "";
                res.on("error", onerror).on("data", function(chunk) {
                    body += chunk;
                })
                .on("end", function() {
                    // The response body of the `open` request contains a result
                    // of handshake. The handshake output is in the form of URI.
                    var result = url.parse(body, true).query;
                    // A newly issued id for HTTP transport. It is used to
                    // identify which HTTP transport is associated with which
                    // HTTP exchange.
                    self.id = result.id;
                    // Before giving a user opportunity to handle transport
                    // through `open` event, polling must be started. Because,
                    // when a user closes the transport on open event, the
                    // active `req` is required.
                    poll();
                    self.emit("open");
                    // Then starts polling.
                    function poll() {
                        // From the second request, `when` param should be
                        // `poll` and `id` param should be added.
                        req = http.get(uri + "&when=poll&id=" + encodeURIComponent(self.id))
                        .on("error", onerror).on("close", onclose)
                        // Reads the response body.
                        .on("response", function(res) {
                            var chunks = [];
                            res.on("error", onerror).on("data", function(chunk) {
                                chunks.push(chunk);
                            })
                            .on("end", function() {
                                if (chunks.length) {
                                    // The complete body in the form of binary.
                                    var body = Buffer.concat(chunks);
                                    // Starts a poll request again before to
                                    // fire `text` event. There must be no idle
                                    // time between polling.
                                    poll();
                                    // Makes the `content-type` header lowercase
                                    // and verifies it. Only when the body
                                    // exists, verification is valid.
                                    switch ((res.headers["content-type"] || "").toLowerCase()) {
                                    // A list of allowed content-type headers
                                    // for text message.
                                    case "text/plain; charset=utf-8":
                                    case "text/plain; charset=utf8":
                                    case "text/plain;charset=utf-8":
                                    case "text/plain;charset=utf8":
                                        // Fires `text` event by decoding the
                                        // body with `utf-8`.
                                        self.emit("text", body.toString("utf-8"));
                                        break;
                                    // An allowed content-type header for binary
                                    // message.
                                    case "application/octet-stream":
                                        // Fires `binary` event with the body.
                                        self.emit("binary", body);
                                        break;
                                    default:
                                        // If the content-type header is
                                        // invalid, fires an error and closes
                                        // the connection.
                                        self.emit("error", new Error("protocol"));
                                        self.close();
                                        break;
                                    }
                                // Empty body indicates the server closed the
                                // socket. Accordingly fires the `close` event.
                                } else {
                                    self.emit("close");
                                }
                            });
                        });
                    }
                });
            });
        };
        self.abort = function() {
            // Node.js fires a 'socket hang up' error if there was no response
            // from the server by default. But, that is a normal case of close
            // in long polling, hence removes all default error handlers.
            req.removeAllListeners("error");
            // To fire `close` event, registers `error` event handler to `req`.
            // The above `response` event handler is called only when response
            // is returned from the server so that `close` event is called only
            // once.
            req.on("error", function() {
                self.emit("close");
            });
            req.abort();
        };
        return self;
    }
};