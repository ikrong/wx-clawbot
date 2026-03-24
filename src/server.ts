import { createServer } from "node:http";
import { createHash } from "node:crypto";
import type { WechatBot } from "./index.js";
import type Stream from "node:stream";

interface WebsocketConnection {
    buffer: Buffer;
    fragments: Buffer<ArrayBufferLike>[];
    isFragment: boolean;
}

export class WechatBotAdapterServer {
    private server: ReturnType<typeof createServer> | null = null;
    private connections = new Map<Stream.Duplex, WebsocketConnection>();
    private routes: Record<string, { route: string; handle: Function }[]> = {};

    constructor(
        private port = 38219,
        private bot?: WechatBot,
    ) {
        this.start();
    }

    private registerRoute(method: string, route: string, handle: Function) {
        if (!this.routes[method]) {
            this.routes[method] = [];
        }
        this.routes[method].push({ route, handle });
    }

    private findRoute(url: string, method: string) {}

    private start() {
        this.server = createServer(async (req, res) => {
            console.log(req);
        });

        this.server.on("upgrade", (req, socket, head) => {
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

            socket.on("end", () => {
                this.connections.delete(socket);
            });

            socket.on("error", () => {
                // noop
            });
        });

        const listen = () => {
            this.server!.listen(this.port);
        };

        listen();

        this.server.on("listening", () => {
            console.log(`WechatBotAdapterServer listening on port ${this.port}`);
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
}
