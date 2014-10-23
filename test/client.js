var parseArgs = require("minimist");
var should = require("chai").should();
var url = require("url");
var http = require("http");
var querystring = require("querystring");
var vibe = require("../lib/index");

http.globalAgent.maxSockets = Infinity;

// A factory to create a group of test
var factory = {
    args: parseArgs(process.argv, {
        default: {
            "vibe.transports": "",
            "vibe.extension": "",
        }
    }).vibe,
    create: function(title, fn) {
        describe(title, function() {
            factory.args.transports.split(",").forEach(function(transport) {
                var args = {transport: transport};
                it(transport, function(done) {
                    this.args = args;
                    fn.apply(this, arguments);
                });
            });
        });
    }
};

describe("client", function() {
    this.timeout(20 * 1000);

    var host = "http://localhost:9000";    
    // To be destroyed
    var sockets = [];
    var netSockets = [];
    // A Vibe server
    var server = vibe.server();
    server.on("socket", function(socket) {
        sockets.push(socket);
        socket.on("close", function() {
            sockets.splice(sockets.indexOf(socket), 1);
        });
    });
    // An HTTP server to install Vibe server
    var httpServer = http.createServer();
    httpServer.on("connection", function(socket) {
        netSockets.push(socket);
        socket.on("close", function () {
            netSockets.splice(netSockets.indexOf(socket), 1);
        });
    })
    .on("request", function(req, res) {
        if (url.parse(req.url).pathname === "/vibe") {
            server.handleRequest(req, res);
        }
    })
    .on("upgrade", function(req, sock, head) {
        if (url.parse(req.url).pathname === "/vibe") {
            server.handleUpgrade(req, sock, head);
        }
    });

    function run(options) {
        server.setTransports(options.transports);
        if (options.heartbeat) {
            server.setHeartbeat(options.heartbeat);
        }
        if (options._heartbeat) {
            server.set_heartbeat(options._heartbeat);
        }
        server.on("socket", function(socket) {
            var query = url.parse(socket.uri, true).query;
            query.transport.should.be.equal(options.transports[0]);
        });
        var params = {uri: "http://localhost:" + httpServer.address().port + "/vibe"};
        // To test multiple clients concurrently
        if (factory.args.session) {
            params.session = factory.args.session;
        }
        http.get(host + "/open?" + querystring.stringify(params));
        return server;
    }
    
    before(function(done) {
        httpServer.listen(0, function() {
            done();
        });
    });
    after(function(done) {
        // To shutdown the web server immediately
        netSockets.forEach(function(socket) {
            socket.destroy();
        });
        httpServer.close(function() {
            done();
        });
    });
    beforeEach(function() {
        // To restore the original stack
        this.socketListeners = server.listeners("socket");
    });
    afterEach(function() {
        // Remove the listener added by the test and restore the original stack
        server.removeAllListeners("socket");
        this.socketListeners.forEach(server.on.bind(server, "socket"));
        // To release stress of browsers, clean sockets
        sockets.forEach(function(socket) {
            socket.close();
        });
    });
    
    factory.create("should open a new socket", function(done) {
        run({transports: [this.args.transport]})
        .on("socket", function(socket) {
            done();
        });
    });
    factory.create("should close the socket", function(done) {
        run({transports: [this.args.transport]})
        .on("socket", function(socket) {
            socket.on("close", function() {
                done();
            })
            // Though the client couldn't fire open event now, it will receive
            // this event some time later.
            .send("abort");
        });
    });
    factory.create("should detect the server's disconnection", function(done) {
        var test = this.test;
        // A client who can't detect disconnection will notice it by heartbeat
        run({transports: [this.args.transport], heartbeat: 10000, _heartbeat: 5000})
        .on("socket", function(socket) {
            socket.on("close", function check() {
                // This request checks if this socket in client is alive or not.
                http.get(host + "/alive?id=" + socket.id, function(res) {
                    var body = "";
                    res.on("data", function(chunk) {
                        body += chunk;
                    })
                    .on("end", function() {
                        // The 'false' body means the client has no such socket
                        // that is a successful case. If not, request again
                        // until the client notices it.
                        if (body === "false") {
                            done();
                        } else if (test.state !== "passed" && !test.timedOut) {
                            setTimeout(check, 1000);
                        }
                    });
                });
            })
            .close();
        });
    });
    factory.create("should exchange an event", function(done) {
        run({transports: [this.args.transport]})
        .on("socket", function(socket) {
            socket.on("echo", function(data) {
                data.should.be.equal("data");
                done();
            })
            .send("echo", "data");
        });
    });
    factory.create("should exchange an event containing of multi-byte characters", function(done) {
        run({transports: [this.args.transport]})
        .on("socket", function(socket) {
            socket.on("echo", function(data) {
                data.should.be.equal("라면");
                done();
            })
            .send("echo", "라면");
        });
    });
    factory.create("should exchange an event of 2KB", function(done) {
        var text2KB = Array(2048).join("K");
        run({transports: [this.args.transport]})
        .on("socket", function(socket) {
            socket.on("echo", function(data) {
                data.should.be.equal(text2KB);
                done();
            })
            .send("echo", text2KB);
        });
    });
    factory.create("should not lose any event in an exchange of one hundred of event", function(done) {
        var timer, sent = [], received = [];
        run({transports: [this.args.transport]})
        .on("socket", function(socket) {
            socket.on("echo", function(i) {
                received.push(i);
                received.sort();
                clearTimeout(timer);
                timer = setTimeout(function() {
                    received.should.be.deep.equal(sent);
                    done();
                }, 1500);
            });
            for (var i = 0; i < 100; i++) {
                (function(i) {
                    setTimeout(function() {
                        sent.push(i);
                        sent.sort();
                        socket.send("echo", i);
                    }, 10);
                })(i);
            }
        });
    });
    factory.create("should support heartbeat", function(done) { 
        run({transports: [this.args.transport], heartbeat: 2500, _heartbeat: 2400})
        .on("socket", function(socket) {
            socket.once("heartbeat", function() {
                this.once("heartbeat", function() {
                    this.once("heartbeat", function() {
                        done();
                    }); 
                });
            });
        });
    });
    factory.create("should close the socket if heartbeat fails", function(done) {
        run({transports: [this.args.transport], heartbeat: 2500, _heartbeat: 2400})
        .on("socket", function(socket) {
            // Breaks heartbeat functionality
            socket.send = function() {
                return this;
            };
            // The client closes a connection because of a failure of the
            // heartbeat and the server regards it as normal closure.
            socket.on("close", function() {
                done();
            });
        });
    });
    if (factory.args.extension.indexOf("reply") !== -1) {
        describe("reply", function() {
            factory.create("should execute the resolve callback when receiving event", function(done) {
                run({transports: [this.args.transport]})
                .on("socket", function(socket) {
                    socket.send("/reply/inbound", {type: "resolved", data: Math.PI}, function(value) {
                        value.should.be.equal(Math.PI);
                        done();
                    }, function() {
                        true.should.be.false;
                    });
                });
            });
            factory.create("should execute the reject callback when receiving event", function(done) {
                run({transports: [this.args.transport]})
                .on("socket", function(socket) {
                    socket.send("/reply/inbound", {type: "rejected", data: Math.PI}, function() {
                        true.should.be.false;
                    }, function(value) {
                        value.should.be.equal(Math.PI);
                        done();
                    });
                });
            });
            factory.create("should execute the resolve callback when sending event", function(done) {
                run({transports: [this.args.transport]})
                .on("socket", function(socket) {
                    socket.on("test", function(data, reply) {
                        reply.resolve(data);
                        this.on("done", function(value) {
                            value.should.be.equal(Math.E);
                            done();
                        });
                    })
                    .send("/reply/outbound", {type: "resolved", data: Math.E});
                });
            });
            factory.create("should execute the reject callback when sending event", function(done) {
                run({transports: [this.args.transport]})
                .on("socket", function(socket) {
                    socket.on("test", function(data, reply) {
                        reply.reject(data);
                        this.on("done", function(value) {
                            value.should.be.equal(Math.E);
                            done();
                        });
                    })
                    .send("/reply/outbound", {type: "rejected", data: Math.E});
                });
            });
        });
    }
});