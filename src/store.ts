import Conf from "conf";
import type { UserConfigEntry } from "./types.js";
import { dirname, basename, parse } from "node:path";

export interface WechatBotConfig {
    botToken: string;
    accountId: string;
    baseUrl: string;
    userId: string;
    updatesBuf: string;
    lastEventAt: number;
    userEntry: UserConfigEntry;
    contextToken: string;

    // server
    serverRegistrationKey: string;
}

export let store: Store;

export abstract class Store {
    abstract get<T extends keyof WechatBotConfig>(key: T): Promise<WechatBotConfig[T]> | WechatBotConfig[T];
    abstract set<T extends keyof WechatBotConfig>(key: T, value: WechatBotConfig[T]): void | Promise<void>;
    abstract delete<T extends keyof WechatBotConfig>(key: T): void | Promise<void>;
}

class DefaultStore implements Store {
    private store: Conf<WechatBotConfig>;

    constructor(config?: { configFilePath?: string; configName?: string }) {
        if (config?.configFilePath) {
            const file = parse(config?.configFilePath);
            this.store = new Conf<WechatBotConfig>({
                cwd: file.dir,
                configName: file.name,
                fileExtension: file.ext.slice(1) || "json",
            });
        } else {
            this.store = new Conf<WechatBotConfig>({ projectName: config?.configName || "wx-clawbot" });
        }
    }
    get<T extends keyof WechatBotConfig>(key: T): WechatBotConfig[T] {
        return this.store.get(key);
    }
    set<T extends keyof WechatBotConfig>(key: T, value: WechatBotConfig[T]): void {
        return this.store.set(key, value);
    }
    delete<T extends keyof WechatBotConfig>(key: T): void {
        return this.store.delete(key);
    }
}

export function initStore(config?: { configFilePath?: string; configName?: string; store?: Store }) {
    if (config?.store) {
        store = config.store;
        return;
    }
    store = new DefaultStore(config);
}
