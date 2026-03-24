import type { WechatBotApiClient } from "./client.js";
import { store } from "./store.js";
import { MessageItemType, type WeixinMessage } from "./types.js";

let typingTimer: any = null;

export class Message {
    get text() {
        return this.getTextBody()?.trim();
    }

    get hasMedia() {
        return !!this.getMedia();
    }

    get contextToken() {
        return this.item?.context_token || store.get("contextToken");
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
            if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
                return item.voice_item.text;
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
                (i.type === MessageItemType.VOICE && i.voice_item?.media?.encrypt_query_param && !i.voice_item.text)
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

    downloadMedia() {
        const media = this.getMedia();
        if (!media) return;
        return this.client.downloadMedia(media);
    }

    async sendText(text: string) {
        await this.client.sendText(text, this.contextToken!);
    }

    async sendImage(filePath: string) {
        await this.client.sendImage(filePath, this.contextToken!);
    }

    async sendVideo(filePath: string) {
        await this.client.sendVideo(filePath, this.contextToken!);
    }

    async sendFile(filePath: string) {
        await this.client.sendFile(filePath, this.contextToken!);
    }

    private async getTypingTicket() {
        const entry = store.get("userEntry");
        const shouldFetch = !entry || Date.now() >= entry.nextFetchAt;

        if (shouldFetch) {
            let ok = false;
            try {
                const resp = await this.client.getConfig({
                    contextToken: this.contextToken,
                });

                if (resp.ret === 0) {
                    store.set("userEntry", {
                        config: {
                            typingTicket: resp.typing_ticket,
                        },
                        everSucceeded: true,
                        nextFetchAt: Date.now() + Math.random() * 24 * 60 * 60 * 1000,
                        retryDelayMsg: 2_000,
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
                    store.set("userEntry", entry);
                } else {
                    store.set("userEntry", {
                        config: { typingTicket: "" },
                        everSucceeded: false,
                        nextFetchAt: Date.now() + 2_000,
                        retryDelayMs: 2_000,
                    });
                }
            }
        }

        return store.get("userEntry")?.config.typingTicket || "";
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
}
