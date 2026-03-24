import EventEmitter from "node:events";
import { WechatBotApiClient } from "./client.js";
import { store } from "./store.js";
import { sleep } from "./utils.js";
import { Message } from "./message.js";

export interface WechatBotMessage {
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
}

export class WechatBot extends EventEmitter<WechatBotMessage> {
    private client = new WechatBotApiClient();
    private abortController = new AbortController();

    async ensureLogin() {
        const token = store.get("botToken");
        let isLogin = false;
        if (token) {
            const p = new Promise((r) => {
                this.once("logout", () => r(false));
                this.once("connected", () => r(true));
            });
            this.waitMessage();
            await p;
        }
        if (!isLogin) {
            this.once("login", ({ status }) => (isLogin = status === "success"));
            await this.login();
            if (!isLogin) {
                throw new Error("登录失败");
            }
            this.waitMessage();
        }

        return this;
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

                const isErr = updates.ret !== 0 || updates.errcode !== 0;
                const isSessionExpired = isErr && (updates.errcode === -14 || updates.ret === -14);

                if (isErr && isSessionExpired) {
                    return this.emit("logout");
                }

                if (isErr) {
                    failures++;

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

                this.emit("connected");

                for (const msg of updates.msgs || []) {
                    store.set("contextToken", msg.context_token);

                    this.emit("message", new Message(this.client, msg));
                }
            } catch (error) {
                if (this.abortController.signal.aborted) {
                    return;
                }
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
