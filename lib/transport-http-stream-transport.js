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
// `createHttpStreamTransport` as a factory to create a HTTP streaming
// transport. In streaming, the client performs a HTTP persistent connection and
// watches changes in response and the server prints chunk as message to
// response.
module.exports = function(uri, options) {
    var urlObj = url.parse(uri, true);
    // URI's protocol should be either `http` or `https` and transport param
    // should be `stream`.
    if ((urlObj.protocol === "http:" || urlObj.protocol === "https:") && urlObj.query.transport === "stream") {
        // A transport object.
        var self = createHttpBaseTransport(uri, options);
        // Any error on request-response should propagate to transport.
        function onerror(error) {
            self.emit("error", error);
        }

        var req;
        self.connect = function() {
            // Performs a HTTP persistent connection through `GET` method.
            // `when` param should be `open`. In case of Server-Sent Events,
            // `sse` param should be `true`.
            req = http.get(uri + "&when=open")
            .on("error", onerror).on("response", function(res) {
                // When to fire `open` event is a first message which is an
                // output of handshaking not when the response is available.
                var handshaked = false;
                function onmessage(data) {
                    if (!handshaked) {
                        handshaked = true;
                        // The handshake output is in the form of URI.
                        var result = url.parse(data, true).query;
                        // A newly issued id for HTTP transport. It is used to
                        // identify which HTTP transport is associated with
                        // which HTTP exchange.
                        self.id = result.id;
                        // And then fire `open` event.
                        self.emit("open");
                    } else {
                        self.emit("text", data);
                    }
                }
                // Every chunk may be a single message, multiple messages or a
                // fragment of a single message. This buffer helps handle
                // fragments.
                var buffer = "";
                // Chunks are formatted according to the [event stream
                // format](http://www.w3.org/TR/eventsource/#event-stream-interpretation).
                // However, you don't need to know that. A single message starts
                // with 'data: ' and ends with `\n\n`. That's all you need to
                // know.
                res.on("error", onerror).on("data", function(chunk) {
                    // Strips off the left padding of the chunk that appears in
                    // the first chunk.
                    chunk = chunk.toString().replace(/^\s+/, "");
                    // If the chunk consists of only whitespace characters that
                    // is the first chunk padding in the above, there is nothing
                    // to do.
                    if (!chunk) {
                        return;
                    }
                    // Let's think of a series of the following chunks:
                    // * `"data: {}\n\ndata: {}\n\n"`
                    // * `"data: {}\n\ndata: {"`
                    // * `"}\n\ndata:{"`
                    // * `".."`
                    // * `".}"`
                    // * `"\n\ndata: {}\n\n"`
                    // 
                    // It looks not easy to handle. So let's concatenate buffer
                    // and chunk. Here the buffer is a string after last `\n\n`
                    // of the concatenation.
                    // * `""` + `"data: {}\n\ndata: {}\n\n"`
                    // * `""` + `"data: {}\n\ndata: {"`
                    // * `"data: {"` + `"}\n\ndata:{"`
                    // * `"data: {"` + `".."`
                    // * `"data: {.."` + `".}"`
                    // * `"data: {...}"` + `"\n\ndata: {}\n\n"`
                    
                    // Let's split the concatenation by `\n\n`.
                    (buffer + chunk).split("\n\n").forEach(function(line, i, lines) {
                        // Except the last element, unwraps 'data: ' and fires a
                        // message event.
                        if (i < lines.length - 1) {
                            onmessage(line.substring("data: ".length));
                        } else {
                            // The last element is a fragment of a data which is
                            // an incomplete message. Assigns it to buffer.
                            buffer = line;
                        }
                    });
                })
                // The end of response corresponds to the close of transport.
                .on("end", function() {
                    self.emit("close");
                });
            });
        };
        self.abort = function() {
            // Aborts the current request. The rest of work, firing the `close`
            // event, will be done by `res`'s `end` event handler.
            req.abort();
        };
        return self;
    }
};