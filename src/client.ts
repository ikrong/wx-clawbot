import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import {
    MessageItemType,
    MessageState,
    MessageType,
    type GetConfigResp,
    type GetUpdatesResp,
    type GetUploadUrlReq,
    type GetUploadUrlResp,
    type MessageItem,
    type SendTypingReq,
    type WeixinMessage,
} from "./types.js";
import { getMimeFromFilename } from "./utils.js";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

const BASE_URL = "https://ilinkai.weixin.qq.com";
const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const CHANNEL_VERSION = "1.0.2";

export class WechatBotApiClient {
    private accountId?: string;
    private userId?: string;
    private botToken?: string;
    private baseUrl = BASE_URL;
    private cdnBaseUrl = CDN_BASE_URL;

    constructor(opts?: {
        accountId?: string;
        userId?: string;
        botToken?: string;
        baseUrl?: string;
        cdnBaseUrl?: string;
    }) {
        if (opts) {
            this.setAuthorizations(opts);
        }
    }

    setAuthorizations(opts: {
        accountId?: string;
        userId?: string;
        botToken?: string;
        baseUrl?: string;
        cdnBaseUrl?: string;
    }) {
        if (opts.accountId) this.accountId = opts.accountId;
        if (opts.userId) this.userId = opts.userId;
        if (opts.botToken) this.botToken = opts.botToken;
        if (opts.baseUrl) this.baseUrl = opts.baseUrl;
        if (opts.cdnBaseUrl) this.cdnBaseUrl = opts.cdnBaseUrl;
    }

    private formatUrl(base: string, path: string, query?: Record<string, any>): string {
        base = base.replace(/\/$/, "") + "/";
        const url = new URL(path, base);
        if (query) {
            Object.entries(query).forEach(([key, value]) => {
                url.searchParams.set(key, value);
            });
        }
        return url.href;
    }

    private getBaseApiUrl(path: string, query?: Record<string, any>) {
        return this.formatUrl(this.baseUrl, path, query);
    }

    private getCdnApiUrl(path: string, query?: Record<string, any>) {
        return this.formatUrl(this.cdnBaseUrl, path, query);
    }

    async getQrcode(): Promise<{
        qrcode: string;
        qrcode_img_content: string;
    }> {
        const resp = await fetch(
            this.getBaseApiUrl("/ilink/bot/get_bot_qrcode", {
                bot_type: 3,
            }),
            {
                headers: {},
            },
        );
        if (resp.ok) return await resp.json();
        const body = await resp.text().catch(() => "(unreadable)");
        throw new Error(`获取二维码失败 ${resp.status} ${body}`);
    }

    async checkQrcodeStatus(qrcode: string): Promise<{
        status: "wait" | "scaned" | "confirmed" | "expired";
        bot_token?: string;
        baseurl?: string;
        ilink_bot_id?: string;
        ilink_user_id?: string;
    }> {
        const url = new URL(
            `ilink/bot/get_qrcode_status?${new URLSearchParams({
                qrcode: qrcode,
            })}`,
            BASE_URL,
        );
        const abortSignal = AbortSignal.timeout(35000);
        try {
            const resp = await fetch(url.href, {
                headers: {
                    "iLink-App-ClientVersion": "1",
                },
                signal: abortSignal,
            });
            const text = await resp.text();
            if (resp.ok) return JSON.parse(text);
            else throw new Error(`获取二维码状态失败 ${resp.status} ${text}`);
        } catch (error) {
            if (error instanceof Error && error.name === "AbortError") {
                return { status: "wait" };
            }
            throw error;
        }
    }

    private async fetch(opts: { url: string; body: string; timeoutMs?: number }) {
        const url = new URL(opts.url, BASE_URL);
        const abortSignal = AbortSignal.timeout(opts.timeoutMs || 35000);
        try {
            const res = await fetch(url.href, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    AuthorizationType: "ilink_bot_token",
                    "Content-Length": String(Buffer.byteLength(opts.body, "utf-8")),
                    "X-WECHAT-UIN": Buffer.from(String(randomBytes(4).readUInt32BE(0)), "utf-8").toString("base64"),
                    Authorization: `Bearer ${this.botToken!.trim()}`,
                },
                body: opts.body,
                signal: abortSignal,
            });
            const text = await res.text();
            if (!res.ok) throw new Error(`${res.status} ${text}`);
            return text;
        } catch (error) {
            throw error;
        }
    }

    async getMessages(opts: { get_updates_buf: string; timeoutMs?: number }): Promise<GetUpdatesResp> {
        try {
            const text = await this.fetch({
                url: "ilink/bot/getupdates",
                body: JSON.stringify({
                    get_updates_buf: opts.get_updates_buf,
                    base_info: { channel_version: CHANNEL_VERSION },
                }),
            });
            return JSON.parse(text);
        } catch (error) {
            if (error instanceof Error && error.name === "AbortError") {
                return {
                    ret: 0,
                    msgs: [],
                    get_updates_buf: opts.get_updates_buf!,
                };
            }
            throw error;
        }
    }

    async sendMessage(body: WeixinMessage) {
        if (!body.context_token) throw new Error("context_token缺失");
        await this.fetch({
            url: "ilink/bot/sendmessage",
            body: JSON.stringify({
                msg: {
                    ...body,
                    client_id: `openclaw-weixin:${Date.now()}-${randomBytes(4).toString("hex")}`,
                },
                base_info: { channel_version: CHANNEL_VERSION },
            }),
        });
    }

    async getConfig(opts: { contextToken?: string }): Promise<GetConfigResp> {
        const text = await this.fetch({
            url: "ilink/bot/getconfig",
            body: JSON.stringify({
                ilink_user_id: this.userId,
                context_token: opts.contextToken || "",
                base_info: { channel_version: CHANNEL_VERSION },
            }),
        });
        return JSON.parse(text);
    }

    async sendTyping(body: SendTypingReq) {
        await this.fetch({
            url: "ilink/bot/sendtyping",
            body: JSON.stringify({
                ...body,
                ilink_user_id: this.userId,
                base_info: { channel_version: CHANNEL_VERSION },
            }),
        });
    }

    async getUploadUrl(opts: GetUploadUrlReq): Promise<GetUploadUrlResp> {
        const text = await this.fetch({
            url: "ilink/bot/getuploadurl",
            body: JSON.stringify({
                filekey: opts.filekey,
                media_type: opts.media_type,
                to_user_id: opts.to_user_id,
                rawsize: opts.rawsize,
                rawfilemd5: opts.rawfilemd5,
                filesize: opts.filesize,
                thumb_rawsize: opts.thumb_rawsize,
                thumb_rawfilemd5: opts.thumb_rawfilemd5,
                thumb_filesize: opts.thumb_filesize,
                no_need_thumb: opts.no_need_thumb,
                aeskey: opts.aeskey,
                base_info: { channel_version: CHANNEL_VERSION },
            }),
        });
        return JSON.parse(text);
    }

    private async downloadMediaBuffer(encryptedQueryParam: string, aesKeyBase64: string) {
        const res = await fetch(
            this.getCdnApiUrl("download", {
                encrypted_query_param: encryptedQueryParam,
            }),
        );
        const buf = Buffer.from(await res.arrayBuffer());
        const decipher = createDecipheriv("aes-128-ecb", Buffer.from(aesKeyBase64, "base64"), null);
        return Buffer.concat([decipher.update(buf), decipher.final()]);
    }

    private async downloadPlainMediaBuffer(encryptedQueryParam: string) {
        const res = await fetch(
            this.getCdnApiUrl("download", {
                encrypted_query_param: encryptedQueryParam,
            }),
        );
        return Buffer.from(await res.arrayBuffer());
    }

    async downloadMedia(media: MessageItem): Promise<{
        buffer: Buffer;
        type: "image" | "voice" | "file" | "video";
        contentType?: string;
        filename?: string;
    } | void> {
        if (media.type === MessageItemType.IMAGE) {
            if (media.image_item?.media?.encrypt_query_param) {
                const aesKey = media.image_item.aeskey
                    ? Buffer.from(media.image_item.aeskey, "hex").toString("base64")
                    : media.image_item.aeskey;
                const buf = aesKey
                    ? await this.downloadMediaBuffer(media.image_item.media.encrypt_query_param, aesKey)
                    : await this.downloadPlainMediaBuffer(media.image_item.media.encrypt_query_param);
                return { type: "image", buffer: buf };
            }
        } else if (media.type === MessageItemType.VOICE) {
            if (media.voice_item?.media?.encrypt_query_param && media.voice_item?.media?.aes_key) {
                const buf = await this.downloadMediaBuffer(
                    media.voice_item.media.encrypt_query_param,
                    media.voice_item.media.aes_key,
                );
                return { type: "voice", buffer: buf, contentType: "audio/silk" };
            }
        } else if (media.type === MessageItemType.FILE) {
            if (media.file_item?.media?.encrypt_query_param && media.file_item?.media?.aes_key) {
                const buf = await this.downloadMediaBuffer(
                    media.file_item.media.encrypt_query_param,
                    media.file_item.media.aes_key,
                );
                return {
                    type: "file",
                    buffer: buf,
                    filename: media.file_item.file_name!,
                    contentType: getMimeFromFilename(media.file_item.file_name! || "file.bin"),
                };
            }
        } else if (media.type === MessageItemType.VIDEO) {
            if (media.video_item?.media?.encrypt_query_param && media.video_item.media.aes_key) {
                const buf = await this.downloadMediaBuffer(
                    media.video_item.media.encrypt_query_param,
                    media.video_item.media.aes_key,
                );
                return { type: "video", buffer: buf, contentType: "video/mp4" };
            }
        }
    }

    private async uploadMedia(type: 1 | 2 | 3 | 4, filePath: string) {
        const buf = await readFile(filePath);
        const md5 = createHash("md5").update(buf).digest("hex");
        const filesize = Math.ceil((buf.length + 1) / 16) * 16;
        const filekey = randomBytes(16).toString("hex");
        const aesKey = randomBytes(16);

        const uploadRes = await this.getUploadUrl({
            filekey,
            media_type: type,
            to_user_id: this.userId!,
            rawsize: buf.length,
            rawfilemd5: md5,
            filesize,
            no_need_thumb: true,
            aeskey: aesKey.toString("hex"),
        });

        if (!uploadRes.upload_param) {
            throw new Error("Failed to get upload param");
        }

        const cipher = createCipheriv("aes-128-ecb", aesKey, null);

        let tryCount = 1;

        while (true) {
            try {
                const res = await fetch(
                    this.getCdnApiUrl("upload", {
                        encrypted_query_param: uploadRes.upload_param,
                        filekey: filekey,
                    }),
                    {
                        method: "POST",
                        body: new Uint8Array(Buffer.concat([cipher.update(buf), cipher.final()])),
                        headers: {
                            "Content-Type": "application/octet-stream",
                        },
                    },
                );
                const param = res.headers.get("x-encrypted-param");
                if (res.status === 200 && param) {
                    return {
                        param,
                        filekey,
                        aesKey: aesKey.toString("hex"),
                        filesize: buf.length,
                        filesizeCiphertext: filesize,
                    };
                } else {
                    throw new Error(res.headers.get("x-error-message") ?? `Upload err ${res.status}`);
                }
            } catch (error) {
                tryCount++;
                if (tryCount >= 3) {
                    throw error;
                }
            }
        }
    }

    async uploadImage(filePath: string) {
        return this.uploadMedia(1, filePath);
    }

    async uploadVideo(filePath: string) {
        return this.uploadMedia(2, filePath);
    }

    async uploadFile(filePath: string) {
        return this.uploadMedia(3, filePath);
    }

    async sendText(text: string, contextToken: string) {
        await this.sendMessage({
            from_user_id: "",
            to_user_id: this.userId!,
            context_token: contextToken!,
            message_type: MessageType.BOT,
            message_state: MessageState.FINISH,
            item_list: [
                {
                    type: MessageItemType.TEXT,
                    text_item: { text },
                },
            ],
        });
    }

    async sendImage(filePath: string, contextToken: string) {
        const uploaded = await this.uploadImage(filePath);
        await this.sendMessage({
            from_user_id: "",
            to_user_id: this.userId!,
            context_token: contextToken!,
            message_type: MessageType.BOT,
            message_state: MessageState.FINISH,
            item_list: [
                {
                    type: MessageItemType.IMAGE,
                    image_item: {
                        media: {
                            encrypt_query_param: uploaded.param,
                            aes_key: Buffer.from(uploaded.aesKey).toString("base64"),
                            encrypt_type: 1,
                        },
                        mid_size: uploaded.filesizeCiphertext,
                    },
                },
            ],
        });
    }

    async sendVideo(filePath: string, contextToken: string) {
        const uploaded = await this.uploadVideo(filePath);
        await this.sendMessage({
            from_user_id: "",
            to_user_id: this.userId!,
            context_token: contextToken!,
            message_type: MessageType.BOT,
            message_state: MessageState.FINISH,
            item_list: [
                {
                    type: MessageItemType.VIDEO,
                    video_item: {
                        media: {
                            encrypt_query_param: uploaded.param,
                            aes_key: Buffer.from(uploaded.aesKey).toString("base64"),
                            encrypt_type: 1,
                        },
                        video_size: uploaded.filesizeCiphertext,
                    },
                },
            ],
        });
    }

    async sendFile(filePath: string, contextToken: string) {
        const uploaded = await this.uploadFile(filePath);
        await this.sendMessage({
            from_user_id: "",
            to_user_id: this.userId!,
            context_token: contextToken!,
            message_type: MessageType.BOT,
            message_state: MessageState.FINISH,
            item_list: [
                {
                    type: MessageItemType.FILE,
                    file_item: {
                        media: {
                            encrypt_query_param: uploaded.param,
                            aes_key: Buffer.from(uploaded.aesKey).toString("base64"),
                            encrypt_type: 1,
                        },
                        file_name: basename(filePath),
                        len: String(uploaded.filesize),
                    },
                },
            ],
        });
    }
}
