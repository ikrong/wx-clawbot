import EventEmitter from "node:events";
import { WechatBotApiClient } from "./client.js";
import { initStore, Store, store } from "./store.js";
import { sleep } from "./utils.js";
import { Message } from "./message.js";
import { WechatBotAdapterServer } from "./server.js";
import type { WeixinMessage } from "./types.js";
export type { Message } from "./message.js";

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
    error: [Error];
}

export interface WechatBotOptions {
    // 存储配置文件地址，请填写绝对路径
    configFilePath?: string;
    // 配置文件名称，不带后缀, configFile 和 configName 都配置则优先使用configFile
    configName?: string;
    // 自定义存储
    store?: Store;
}

export class WechatBot extends EventEmitter<WechatBotMessage> {
    private client = new WechatBotApiClient();
    private abortController = new AbortController();
    private logging = false;
    private connected = false;
    private server?: WechatBotAdapterServer;

    constructor(options?: WechatBotOptions) {
        super();
        this.on("error", () => void 0);
        initStore({
            configFilePath: options?.configFilePath!,
            configName: options?.configName!,
            store: options?.store!,
        });
    }

    ensureLogin() {
        if (this.logging) return this;
        this.logging = true;
        this._ensureLogin()
            .catch((e) => this.emit("error", e))
            .finally(() => {
                this.logging = false;
            });
        return this;
    }

    runServer() {
        if (!this.server) {
            this.server = new WechatBotAdapterServer({
                bot: this,
            });
        }
        return this;
    }

    private async _ensureLogin() {
        if (this.connected) return;
        this.abortController.abort();
        this.abortController = new AbortController();
        const abortController = this.abortController;
        const token = await store.get("botToken");
        let isLogin = false;
        if (token) {
            this.client.setAuthorizations({
                botToken: token,
                accountId: await store.get("accountId"),
                userId: await store.get("userId"),
                baseUrl: await store.get("baseUrl"),
            });
            let abortListener: any;
            const p = new Promise<boolean>((r, j) => {
                this.once("logout", () => r(false));
                this.once("connected", () => r(true));
                abortController.signal.addEventListener("abort", (abortListener = () => j(new Error("助手关闭"))));
            });
            this.waitMessage();
            isLogin = await p;
            if (abortListener) {
                abortController.signal.removeEventListener("abort", abortListener);
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
        if (this.abortController.signal.aborted) {
            this.abortController = new AbortController();
        }
        const abortController = this.abortController;
        while (qrcodeGenTime + 480_000 > Date.now()) {
            if (abortController.signal.aborted) return this.emit("login", { status: "failed" });
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
            } else if (status.status === "scaned_but_redirect") {
                if (status.redirect_host) {
                    client.setAuthorizations({
                        baseUrl: `https://${status.redirect_host}`,
                    });
                }
            } else if (status.status === "confirmed") {
                const { bot_token, baseurl, ilink_bot_id, ilink_user_id } = status;
                if (ilink_bot_id && bot_token) {
                    this.client.setAuthorizations({
                        botToken: bot_token!,
                        userId: ilink_user_id!,
                        accountId: ilink_bot_id!,
                    });
                    await store.set("botToken", bot_token);
                    await store.set("accountId", ilink_bot_id);
                    await store.set("userId", ilink_user_id!);
                    await store.set("baseUrl", baseurl!);
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
        let abortController = this.abortController;

        while (!abortController.signal.aborted) {
            try {
                const prevUpdatesBuf = await store.get("updatesBuf");
                const updates = await this.client.getMessages({
                    get_updates_buf: prevUpdatesBuf,
                    timeoutMs: timeoutMs,
                });
                if (abortController.signal.aborted) return;

                if (updates.longpolling_timeout_ms != null && updates.longpolling_timeout_ms > 0) {
                    timeoutMs = updates.longpolling_timeout_ms;
                }

                const isErr =
                    (updates.ret !== undefined && updates.ret !== 0) ||
                    (updates.errcode !== undefined && updates.errcode !== 0);
                const isSessionExpired = isErr && (updates.errcode === -14 || updates.ret === -14);

                if (isErr && isSessionExpired) {
                    this.connected = false;
                    await store.delete("botToken");
                    await store.delete("contextToken");
                    abortController.abort();
                    return this.emit("logout");
                }

                if (isErr) {
                    failures++;

                    this.emit("error", new Error(`获取消息列表失败`));

                    if (failures >= 3) {
                        failures = 0;
                        await sleep(30_000, abortController.signal);
                    } else {
                        await sleep(2_000, abortController.signal);
                    }

                    if (abortController.signal.aborted) return;
                    continue;
                }

                if (updates.get_updates_buf) {
                    await store.set("updatesBuf", updates.get_updates_buf);
                }

                if (!this.connected) {
                    if (abortController.signal.aborted) return;
                    this.connected = true;
                    this.emit("connected");
                }

                for (const msg of updates.msgs || []) {
                    if (abortController.signal.aborted) return;

                    await store.set("lastEventAt", Date.now());
                    await store.set("contextToken", msg.context_token!);

                    this.emit("message", new Message(this.client, msg));
                }
            } catch (error) {
                if (abortController.signal.aborted) {
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

    readAsMessage(item: WeixinMessage) {
        return new Message(this.client, item);
    }

    close() {
        this.abortController.abort();
        this.abortController = new AbortController();
        this.connected = false;
    }
}
