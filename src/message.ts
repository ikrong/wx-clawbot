import { randomUUID } from "node:crypto";
import type { DownloadProgress, WechatBotApiClient } from "./client.js";
import { store } from "./store.js";
import { MessageItemType, type WeixinMessage } from "./types.js";

let typingTimer: any = null;

export class Message {
    private _id?: string;

    get id() {
        if (this.item?.message_id) {
            return this.item?.message_id;
        }
        if (!this._id) {
            this._id = randomUUID();
        }
        return this._id;
    }

    get text() {
        return this.getTextBody()?.trim();
    }

    get voiceText() {
        return String(
            this.item?.item_list?.find((i) => i.type === MessageItemType.VOICE)?.voice_item?.text || "",
        ).trim();
    }

    get hasMedia() {
        return !!this.getMedia();
    }

    private _contextToken?: string;
    get contextToken() {
        return this.item?.context_token || this._contextToken;
    }

    get timestamp() {
        return this.item?.create_time_ms;
    }

    constructor(
        private client: WechatBotApiClient,
        private item?: WeixinMessage,
    ) {}

    private getTextBody(itemList = this.item?.item_list): string {
        if (!itemList?.length) return "";
        for (const item of itemList) {
            if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
                const text = String(item.text_item.text);
                const ref = item.ref_msg;
                if (!ref) return text;
                if (ref.message_item && this.isMediaItem(ref.message_item.type)) return text;
                const parts: string[] = [];
                if (ref.title) parts.push(ref.title);
                if (ref.message_item) {
                    const refBody = this.getTextBody([ref.message_item]);
                    if (refBody) parts.push(refBody);
                }
                if (!parts.length) return text;
                return `[引用: ${parts.join(" | ")}]\n${text}`;
            }
        }
        return "";
    }

    private isMediaItem(type?: number) {
        return [MessageItemType.IMAGE, MessageItemType.VIDEO, MessageItemType.FILE, MessageItemType.VOICE].includes(
            type as unknown as any,
        );
    }

    private getMedia() {
        const mainItem = this.item?.item_list?.find((i) => {
            return (
                (i.type === MessageItemType.IMAGE && i.image_item?.media?.encrypt_query_param) ||
                (i.type === MessageItemType.VIDEO && i.video_item?.media?.encrypt_query_param) ||
                (i.type === MessageItemType.FILE && i.file_item?.media?.encrypt_query_param) ||
                (i.type === MessageItemType.VOICE && i.voice_item?.media?.encrypt_query_param)
            );
        });

        const refItem = !mainItem
            ? this.item?.item_list?.find(
                  (i) =>
                      i.type === MessageItemType.TEXT &&
                      i.ref_msg?.message_item &&
                      this.isMediaItem(i.ref_msg?.message_item?.type),
              )?.ref_msg?.message_item
            : undefined;

        return mainItem || refItem;
    }

    downloadMedia(progress?: DownloadProgress) {
        const media = this.getMedia();
        if (!media) return;
        return this.client.downloadMedia(media, progress || (() => void 0));
    }

    async ensureContextToken() {
        const token = this.contextToken;
        if (!token) {
            this._contextToken = await store.get("contextToken");
        }
        return this.contextToken;
    }

    async sendText(text: string) {
        await this.client.sendText(text, (await this.ensureContextToken())!);
    }

    async sendImage(filePath: string) {
        await this.client.sendImage(filePath, (await this.ensureContextToken())!);
    }

    async sendVideo(filePath: string) {
        await this.client.sendVideo(filePath, (await this.ensureContextToken())!);
    }

    async sendFile(filePath: string) {
        await this.client.sendFile(filePath, (await this.ensureContextToken())!);
    }

    private async getTypingTicket() {
        const entry = await store.get("userEntry");
        const shouldFetch = !entry || Date.now() >= entry.nextFetchAt;

        if (shouldFetch) {
            let ok = false;
            try {
                const resp = await this.client.getConfig({
                    contextToken: (await this.ensureContextToken())!,
                });

                if (resp.ret === 0) {
                    await store.set("userEntry", {
                        config: {
                            typingTicket: resp.typing_ticket!,
                        },
                        everSucceeded: true,
                        nextFetchAt: Date.now() + Math.random() * 24 * 60 * 60 * 1000,
                        retryDelayMs: 2_000,
                    });
                    ok = true;
                }
            } catch (error) {}

            if (!ok) {
                const prevDelay = entry?.retryDelayMs ?? 2_000;
                const nextDelay = Math.min(prevDelay * 2, 60 * 60 * 1000);
                if (entry) {
                    entry.nextFetchAt = Date.now() + nextDelay;
                    entry.retryDelayMs = nextDelay;
                    await store.set("userEntry", entry);
                } else {
                    await store.set("userEntry", {
                        config: { typingTicket: "" },
                        everSucceeded: false,
                        nextFetchAt: Date.now() + 2_000,
                        retryDelayMs: 2_000,
                    });
                }
            }
        }

        return (await store.get("userEntry"))?.config.typingTicket || "";
    }

    async sendTyping() {
        const ticket = await this.getTypingTicket();
        if (!ticket) return;
        if (typingTimer) {
            clearTimeout(typingTimer);
            typingTimer = null;
        }
        typingTimer = setTimeout(() => {
            typingTimer = null;
            this.sendTyping();
        }, 5_00);
        await this.client.sendTyping({
            typing_ticket: ticket,
            status: 1,
        });
    }

    async stopTyping() {
        clearTimeout(typingTimer);
        typingTimer = null;
        const ticket = await this.getTypingTicket();
        if (ticket) {
            await this.client.sendTyping({
                typing_ticket: ticket,
                status: 2,
            });
        }
    }

    fromJSON(item?: WeixinMessage) {
        if (item) {
            this.item = item;
        }
    }

    toJSON() {
        const item = { ...this.item };
        delete item.context_token;
        return item;
    }
}
