import { createServer, IncomingMessage, type ServerResponse, type RequestListener } from "node:http";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { WechatBot } from "./index.js";
import type Stream from "node:stream";
import EventEmitter from "node:events";
import { store } from "./store.js";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import {
    createReadStream,
    createWriteStream,
    existsSync,
    mkdirSync,
    rm,
    rmdir,
    rmdirSync,
    rmSync,
    unlink,
    unlinkSync,
    WriteStream,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { Writable } from "node:stream";
import type { Message } from "./message.js";

interface WebsocketConnection {
    buffer: Buffer;
    fragments: Buffer<ArrayBufferLike>[];
    isFragment: boolean;
}

type ServerHandleRequest = IncomingMessage & {
    params: Record<string, string>;
    query: URLSearchParams;
    requestBodyTmpFile: string;
    readAsJSON<T extends any>(): Promise<T | null>;
    readAsText(): Promise<string | null>;
    readAsBuffer(): Promise<Buffer | null>;
    readAsUrlEncodedFromBody(): Promise<URLSearchParams | null>;
    readAsMultipartFormData<T extends Record<string, string | { filename: string; path: string }>>(): Promise<T | null>;
};

type ServerHandleResponse = ServerResponse<IncomingMessage> & {
    req: IncomingMessage;
    json: (data: any) => void;
};

type ServerHandle = (req: ServerHandleRequest, res: ServerHandleResponse) => Promise<void>;

export type MediaSaver = (media: {
    buffer: Buffer<ArrayBufferLike>;
    type: "image" | "voice" | "file" | "video";
    contentType?: string;
    filename?: string;
}) => Promise<string>;

export class WechatBotAdapterServer extends EventEmitter {
    private server: ReturnType<typeof createServer> | null = null;
    private connections = new Map<Stream.Duplex, WebsocketConnection>();
    private routes: Record<string, { route: string; handle: ServerHandle; regExp?: RegExp }[]> = {};

    private port: number;
    private bot?: WechatBot;
    private mediaSaver?: MediaSaver;

    constructor(config?: { port?: number; bot?: WechatBot; mediaSaver?: MediaSaver }) {
        super();
        this.on("error", () => void 0);
        this.port = config?.port ?? 38219;
        if (config?.bot) {
            this.bot = config.bot;
        }
        if (config?.mediaSaver) {
            this.mediaSaver = config.mediaSaver;
        }
        this.start();
    }

    private start() {
        // intercepter
        const handle: ServerHandle = async (req, res) => {
            res.json = (data) => {
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify(data));
            };
            const routeMatched = this.findRoute(req.url!, req.method!);
            if (!routeMatched) {
                res.statusCode = 404;
                res.end("");
            } else {
                this.getRequestQuery(req); // get query
                try {
                    if (["post", "put", "patch", "delete"].includes(req.method!.toLowerCase())) {
                        await this.processRequestBody(req, res); // 接收 post body
                    }
                    this.processRequest(req, res); // 添加处理 post body
                } catch (error) {
                    console.error(`${req.url}` + (error instanceof Error ? error.message : error));
                    return;
                }
                req.params = routeMatched.params;
                routeMatched.handle(req, res);
            }
        };
        // server instance
        this.server = createServer(handle as unknown as RequestListener);

        // route config start
        this.registerRoute("get", "/health", this.health);
        this.registerRoute("post", "/api/channel/quick-register", this.quickRegister);
        this.registerRoute("get", "/media", this.getMediaFile);
        // route config end

        // websocket
        this.server.on("upgrade", async (req, socket, head) => {
            if (!["/api/channel/ws"].includes(req.url!.split("?")[0]!)) {
                req.destroy();
                socket.write(["HTTP/1.1 404 Not Found", "", ""].join("\r\n"));
                socket.end();
                return;
            }

            const query = this.getRequestQuery(req as ServerHandleRequest);
            const channelId = query.get("channelId");
            const token = query.get("token");
            if (
                !(
                    channelId &&
                    token &&
                    channelId === (await store.get("accountId")) &&
                    token === (await store.get("botToken"))
                )
            ) {
                req.destroy();
                socket.write(["HTTP/1.1 401 Unauthorized", "", ""].join("\r\n"));
                socket.end();
                return;
            }

            const key = req.headers["sec-websocket-key"];
            const accept = createHash("sha1")
                .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
                .digest("base64");

            socket.write(
                [
                    "HTTP/1.1 101 Switching Protocols",
                    "Upgrade: websocket",
                    "Connection: Upgrade",
                    "Sec-WebSocket-Accept: " + accept,
                    "",
                    "",
                ].join("\r\n"),
            );

            this.connections.set(socket, {
                buffer: Buffer.alloc(0),
                fragments: [],
                isFragment: false,
            });

            socket.on("data", (chunk) => {
                const conn = this.connections.get(socket);
                if (conn) {
                    conn.buffer = Buffer.concat([conn.buffer, chunk]);
                    this.parseSocketFrame(socket, conn);
                }
            });

            const onWechatMessage = async (msg: Message) => {
                this.sendSocketMessage(
                    socket,
                    Buffer.from(
                        JSON.stringify({
                            id: msg.id,
                            content: {
                                text: msg.text,
                            },
                            sender: {
                                id: await store.get("userId"),
                            },
                            timestamp: msg.timestamp,
                            media: msg.hasMedia
                                ? (async () => {
                                      const media = await msg.downloadMedia();

                                      if (this.mediaSaver) {
                                          const mediaPath = await this.mediaSaver(media!);
                                          const url = new URL(`http://localhost:${this.port}/media`);
                                          url.searchParams.set("media", mediaPath);
                                          url.searchParams.set("contentType", media?.contentType! || "");
                                          url.searchParams.set("filename", media?.filename! || "");
                                          url.searchParams.set("type", media?.type!);
                                          switch (media?.type) {
                                              case "voice":
                                                  return [
                                                      {
                                                          type: "audio",
                                                          url: url.href,
                                                      },
                                                  ];
                                              default:
                                                  return [
                                                      {
                                                          type: media?.type,
                                                          url: url.href,
                                                      },
                                                  ];
                                          }
                                      }
                                  })()
                                : [],
                        }),
                    ),
                );
            };

            if (this.bot) {
                this.bot.on("message", onWechatMessage);
            }

            socket.on("end", () => {
                this.connections.delete(socket);
                if (this.bot) {
                    this.bot.off("message", onWechatMessage);
                }
            });

            socket.on("error", () => {
                // noop
            });
        });

        // bind port and check port in use
        const listen = () => {
            this.server!.listen(this.port);
        };

        listen();

        this.server.on("listening", async () => {
            console.log(`WechatBotAdapterServer listening on port ${this.port}`);
            let rk = await store.get("serverRegistrationKey");
            if (!rk) {
                rk = randomBytes(16).toString("hex");
                await store.set("serverRegistrationKey", rk);
            }
            this.emit("ready", {
                port: this.port,
                registrationKey: rk,
            });
        });

        this.server.on("error", (err: { code: string }) => {
            if (err.code === "EADDRINUSE") {
                this.port++;
                listen();
            }
        });
    }

    private parseSocketFrame(socket: Stream.Duplex, conn: WebsocketConnection) {
        const buffer = conn.buffer;
        if (buffer.length < 2) return;

        const byte1 = buffer[0]!;
        const fin = (byte1 & 0x80) !== 0; // 是否最后一帧
        const opcode = byte1 & 0x0f; // 帧类型

        // 关闭帧
        if (opcode === 0x8) {
            socket.end();
            return;
        }

        const byte2 = buffer[1]!;
        const masked = (byte2 & 0x80) !== 0;
        let payloadLen = byte2 & 0x7f;

        let pos = 2;

        // ========== 关键修复1：处理扩展长度 ==========
        if (payloadLen === 126) {
            if (buffer.length < pos + 2) return;
            payloadLen = buffer.readUInt16BE(pos);
            pos += 2;
        } else if (payloadLen === 127) {
            if (buffer.length < pos + 8) return;
            payloadLen = Number(buffer.readBigUInt64BE(pos));
            pos += 8;
        }

        // 掩码
        if (masked) {
            if (buffer.length < pos + 4) return;
            const mask = buffer.subarray(pos, pos + 4);
            pos += 4;

            if (buffer.length < pos + payloadLen) return;

            // 解码数据
            const data = buffer.subarray(pos, pos + payloadLen);
            for (let i = 0; i < data.length; i++) {
                data[i]! ^= mask[i % 4]!;
            }

            // ========== 关键修复2：处理消息分片 ==========
            if (opcode === 0) {
                // 继续帧
                conn.fragments.push(data);
            } else {
                // 开始帧
                conn.fragments = [data];
                conn.isFragment = !fin;
            }

            // 消息完整
            if (fin) {
                const allBuffer = Buffer.concat(conn.fragments);
                // sendData(socket, `服务器已收到：${fullMsg.length} 字节`);
            }

            // 移除已处理数据
            conn.buffer = buffer.subarray(pos + payloadLen);
        }
    }

    private sendSocketMessage(socket: Stream.Duplex, buffer: Buffer) {
        const len = buffer.length;
        let header;

        if (len <= 125) {
            header = Buffer.from([0x81, len]);
        } else if (len <= 0xffff) {
            header = Buffer.alloc(4);
            header[0] = 0x81;
            header[1] = 126;
            header.writeUInt16BE(len, 2);
        } else {
            header = Buffer.alloc(10);
            header[0] = 0x81;
            header[1] = 127;
            header.writeBigUInt64BE(BigInt(len), 2);
        }

        socket.write(Buffer.concat([header, buffer]));
    }

    private registerRoute(method: string, route: string, handle: ServerHandle) {
        method = method.toLowerCase();
        if (!this.routes[method]) {
            this.routes[method] = [];
        }
        this.routes[method]!.push({ route, handle });
    }

    private getRouteRegExp(routePathConfig: string) {
        return new RegExp(
            `^${routePathConfig.replace(/\/|:[a-z]+/gi, (a) => {
                if (a === "/") return "\\/";
                return `(?<${a.substring(1)}>[a-z0-9A-Z\-_\.~!\$&'\(\)\*\+,;=@]+)`;
            })}`,
        );
    }

    private findRoute(url: string, method: string) {
        method = method.toLowerCase();
        const routes = this.routes[method] || [];
        const route = routes.find((r) => {
            if (!r.regExp) {
                r.regExp = this.getRouteRegExp(r.route);
            }
            r.regExp.lastIndex = 0;
            if (r.regExp.test(url)) return true;
        });
        if (route) {
            route.regExp!.lastIndex = 0;
            const reg = route.regExp!.exec(url);
            return {
                ...route,
                params: reg?.groups || {},
            };
        }
    }

    private getRequestQuery(req: ServerHandleRequest) {
        if (!req.query) {
            if (req.url!.indexOf("?") >= 0) {
                req.query = new URLSearchParams(req.url!.substring(req.url!.indexOf("?") + 1));
            } else {
                req.query = new URLSearchParams();
            }
        }
        return req.query;
    }

    private processRequestBody(req: ServerHandleRequest, res: ServerHandleResponse) {
        return new Promise<void>((r, j) => {
            const tmpFile = join(tmpdir(), `wx-server-${randomUUID()}.raw`);
            const writeStream = createWriteStream(tmpFile);
            req.requestBodyTmpFile = tmpFile;
            let cleaned = false;
            let finished = false;

            function cleanup() {
                if (cleaned) return;
                cleaned = true;

                if (!finished) {
                    finished = true;

                    res.statusCode = 500;
                    res.end();

                    j("Request body processing failed.");
                }

                if (!writeStream.destroyed) {
                    writeStream.destroy();
                }

                if (existsSync(tmpFile)) {
                    unlink(tmpFile, () => void 0);
                }
            }

            req.on("aborted", cleanup);
            req.on("error", cleanup);
            res.on("finish", cleanup);
            writeStream.on("error", cleanup);

            const maxLength = 1024 * 1024 * 100; // 100M

            let len = 0;
            function checlLen() {
                if (len > maxLength) {
                    finished = true;

                    res.statusCode = 413;
                    res.end();

                    req.destroy();
                    writeStream.destroy();

                    j(new Error(`Content-Length too long: ${len}`));

                    cleanup();
                }
            }
            if (req.headers["content-length"]) {
                len = Number(len);
                checlLen();
            }

            req.on("data", (chunk) => {
                len += chunk.length;
                checlLen();
            });

            req.pipe(writeStream).on("finish", () => {
                finished = true;
                r();
            });
        });
    }

    private async processRequest(req: ServerHandleRequest, res: ServerHandleResponse) {
        const file = req.requestBodyTmpFile;

        req.readAsJSON = async () => {
            if (existsSync(file)) {
                const data = await readFile(file, "utf-8");
                return JSON.parse(data);
            }
            return null;
        };
        req.readAsText = async () => {
            if (existsSync(file)) {
                return await readFile(file, "utf-8");
            }
            return null;
        };
        req.readAsBuffer = async () => {
            if (existsSync(file)) {
                return await readFile(file);
            }
            return null;
        };
        req.readAsUrlEncodedFromBody = async () => {
            if (existsSync(file)) {
                const data = await readFile(file, "utf-8");
                return new URLSearchParams(data);
            }
            return null;
        };
        req.readAsMultipartFormData = () => {
            return new Promise<any>((r, j) => {
                if (!existsSync(file)) return r(null);

                const boundary = "--" + req.headers["content-type"]!.split("boundary=")[1];
                const uploadDir = join(tmpdir(), `wx-server-files`, randomUUID());
                if (!existsSync(uploadDir)) mkdirSync(uploadDir);

                function cleanup() {
                    if (existsSync(uploadDir)) rmSync(uploadDir, { recursive: true });
                }

                res.once("finish", cleanup);
                req.once("aborted", cleanup);
                req.once("error", cleanup);

                const fields: Record<string, string | { filename: string; path: string }> = {};
                let fileStream: WriteStream | null = null;
                let fileStreamCount = 0;
                let buffer = Buffer.alloc(0);
                let parserEnd = false;

                const readStream = createReadStream(file);

                const parser = new Writable({
                    write(chunk, encoding, callback) {
                        buffer = Buffer.concat([buffer, chunk]);

                        while (true) {
                            const boundaryIndex = buffer.indexOf(boundary);
                            if (boundaryIndex === -1) break;

                            const part = buffer.slice(0, boundaryIndex);
                            buffer = buffer.slice(boundaryIndex + boundary.length);
                            if (part.length < 3) continue;

                            const headerEnd = part.indexOf("\r\n\r\n");
                            if (headerEnd === -1) continue;

                            const header = part.slice(0, headerEnd).toString();
                            const body = part.slice(headerEnd + 4);

                            const fieldMatch = header.match(/name="([^"]+)"/);
                            const filenameMatch = header.match(/filename="([^"]+)"/);
                            if (!fieldMatch) continue;

                            const fieldName = fieldMatch[1]!;
                            const filename = filenameMatch?.[1];

                            if (filename) {
                                const safeName = basename(filename);
                                const destPath = join(uploadDir, safeName);
                                fileStreamCount++;

                                fileStream = createWriteStream(destPath);
                                fileStream.on("finish", () => {
                                    console.log("fileStream finish");
                                    fields[fieldName] = { filename: safeName, path: destPath };
                                    fileStreamCount--;
                                    if (fileStreamCount === 0 && parserEnd) {
                                        r(fields);
                                    }
                                });
                                fileStream.write(body);
                                fileStream.end();
                            } else {
                                fields[fieldName] = body.toString().trim();
                            }
                        }
                        callback();
                    },
                });

                readStream.pipe(parser);

                parser.on("finish", () => {
                    parserEnd = true;
                    if (!fileStream) r(fields);
                });
                parser.on("error", j);
                readStream.on("error", j);
            });
        };
    }

    // http config

    private health: ServerHandle = async (req, res) => {
        res.json({
            status: "ok",
            timestamp: new Date().toISOString(),
        });
    };

    private quickRegister: ServerHandle = async (req, res) => {
        const data = await req.readAsJSON<{ key: string }>();

        if (data && data.key === (await store.get("serverRegistrationKey"))) {
            const channelId = await store.get("accountId");
            const accessToken = await store.get("botToken");
            if (channelId && accessToken) {
                res.json({
                    data: {
                        channelId,
                        accessToken,
                    },
                });
                return;
            }
        }
        res.statusCode = 403;
        res.end();
    };

    private channelConnect: ServerHandle = async (req, res) => {
        const accessToken = req.headers["x-access-token"];
        if (accessToken && accessToken === (await store.get("botToken"))) {
            const data = await req.readAsJSON<{
                channelId: string;
                pluginVersion: string;
                workingDir: string;
            }>();
        }

        res.end();
    };

    private channelDisconnect: ServerHandle = async (req, res) => {
        const accessToken = req.headers["x-access-token"];
        if (accessToken && accessToken === (await store.get("botToken"))) {
            const data = await req.readAsJSON<{
                channelId: string;
            }>();
        }

        res.end();
    };

    private getMediaFile: ServerHandle = async (req, res) => {
        //   const url = new URL(`http://localhost:${this.port}/media`);
        //   url.searchParams.set("media", mediaPath);
        //   url.searchParams.set("contentType", media?.contentType! || "");
        //   url.searchParams.set("filename", media?.filename! || "");
        //   url.searchParams.set("type", media?.type!);
        const mediaPath = req.query.get("media");
        const contentType = req.query.get("contentType");
        const filename = req.query.get("filename");
        const type = req.query.get("type");

        if (mediaPath && existsSync(mediaPath)) {
            res.setHeader("Content-Type", contentType!);
            createReadStream(mediaPath).pipe(res);
        } else {
            res.statusCode = 404;
            res.end();
        }
    };
}
