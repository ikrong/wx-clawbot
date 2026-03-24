import EventEmitter from "node:events";
import { WechatBotApiClient } from "./client.js";
import { store } from "./store.js";
import { sleep } from "./utils.js";
import { Message } from "./message.js";

interface WechatBotMessage {
    login: [
        | {
              status: "failed";
          }
        | {
              status: "success";
              timestamp: number;
              botToken: string;
              baseUrl: string;
              userId: string;
              accountId: string;
          },
    ];
    scan: [
        {
            url: string;
        },
    ];
    scaned: [];
    logout: [];
    message: [Message];
    connected: [];
    error: [Error];
}

export class WechatBot extends EventEmitter<WechatBotMessage> {
    private client = new WechatBotApiClient();
    private abortController = new AbortController();
    private connected = false;

    constructor() {
        super();
        this.on("error", () => void 0);
    }

    ensureLogin() {
        this._ensureLogin().catch((e) => this.emit("error", e));
        return this;
    }

    private async _ensureLogin() {
        const token = store.get("botToken");
        let isLogin = false;
        if (token) {
            this.client.setAuthorizations({
                botToken: token,
                accountId: store.get("accountId"),
                userId: store.get("userId"),
                baseUrl: store.get("baseUrl"),
            });
            let abortListener: any;
            const p = new Promise((r, j) => {
                this.once("logout", () => r(false));
                this.once("connected", () => r(true));
                this.abortController.signal.addEventListener("abort", (abortListener = () => j(new Error("助手关闭"))));
            });
            this.waitMessage();
            await p;
            if (abortListener) {
                this.abortController.signal.removeEventListener("abort", abortListener);
            }
        }
        if (!isLogin) {
            this.once("login", ({ status }) => (isLogin = status === "success"));
            await this.login();
            if (!isLogin) {
                throw new Error("登录失败");
            }
            this.waitMessage();
        }
    }

    private async login() {
        const client = new WechatBotApiClient();
        let { qrcode, qrcode_img_content } = await client.getQrcode();
        this.emit("scan", { url: qrcode_img_content });
        let qrcodeGenTime = Date.now();
        let scaned = false;
        let qrRefreshCount = 1;
        while (qrcodeGenTime + 480_000 > Date.now()) {
            const status = await client.checkQrcodeStatus(qrcode);
            if (status.status === "scaned") {
                if (!scaned) {
                    this.emit("scaned");
                    scaned = true;
                }
            } else if (status.status === "expired") {
                qrRefreshCount++;
                if (qrRefreshCount > 3) {
                    return this.emit("login", { status: "failed" });
                } else {
                    ({ qrcode, qrcode_img_content } = await client.getQrcode());
                    this.emit("scan", { url: qrcode_img_content });
                    qrcodeGenTime = Date.now();
                    scaned = false;
                }
            } else if (status.status === "confirmed") {
                const { bot_token, baseurl, ilink_bot_id, ilink_user_id } = status;
                if (ilink_bot_id && bot_token) {
                    this.client.setAuthorizations({
                        botToken: bot_token!,
                        userId: ilink_user_id!,
                        accountId: ilink_bot_id!,
                    });
                    store.set("botToken", bot_token);
                    store.set("accountId", ilink_bot_id);
                    store.set("userId", ilink_user_id);
                    store.set("baseUrl", baseurl);
                    this.abortController = new AbortController();
                    return this.emit("login", {
                        status: "success",
                        botToken: bot_token!,
                        baseUrl: baseurl!,
                        userId: ilink_user_id!,
                        accountId: ilink_bot_id!,
                        timestamp: Date.now(),
                    });
                } else {
                    return this.emit("login", { status: "failed" });
                }
            }
        }
        return this.emit("login", { status: "failed" });
    }

    private async waitMessage() {
        let timeoutMs = 35_000;
        let failures = 1;

        while (!this.abortController.signal.aborted) {
            try {
                const prevUpdatesBuf = store.get("updatesBuf");
                const updates = await this.client.getMessages({
                    get_updates_buf: prevUpdatesBuf,
                    timeoutMs: timeoutMs,
                });

                if (updates.longpolling_timeout_ms != null && updates.longpolling_timeout_ms > 0) {
                    timeoutMs = updates.longpolling_timeout_ms;
                }

                const isErr =
                    (updates.ret !== undefined && updates.ret !== 0) ||
                    (updates.errcode !== undefined && updates.errcode !== 0);
                const isSessionExpired = isErr && (updates.errcode === -14 || updates.ret === -14);

                if (isErr && isSessionExpired) {
                    this.connected = false;
                    store.delete("botToken");
                    store.delete("contextToken");
                    this.abortController.abort();
                    return this.emit("logout");
                }

                if (isErr) {
                    failures++;

                    this.emit("error", new Error(`获取消息列表失败`));

                    if (failures >= 3) {
                        failures = 0;
                        await sleep(30_000, this.abortController.signal);
                    } else {
                        await sleep(2_000, this.abortController.signal);
                    }

                    continue;
                }

                store.set("lastEventAt", Date.now());
                if (updates.get_updates_buf) {
                    store.set("updatesBuf", updates.get_updates_buf);
                }

                if (!this.connected) {
                    this.connected = true;
                    this.emit("connected");
                }

                for (const msg of updates.msgs || []) {
                    store.set("contextToken", msg.context_token);

                    this.emit("message", new Message(this.client, msg));
                }
            } catch (error) {
                if (this.abortController.signal.aborted) {
                    return;
                }

                this.emit("error", error instanceof Error ? error : new Error(String(error)));
            }
        }
    }

    sendText(text: string) {
        return new Message(this.client).sendText(text);
    }

    sendImage(filePath: string) {
        return new Message(this.client).sendImage(filePath);
    }

    sendFile(filePath: string) {
        return new Message(this.client).sendFile(filePath);
    }

    sendVideo(filePath: string) {
        return new Message(this.client).sendVideo(filePath);
    }

    sendTyping() {
        return new Message(this.client).sendTyping();
    }

    stopTyping() {
        return new Message(this.client).stopTyping();
    }

    close() {
        this.abortController.abort();
    }
}
