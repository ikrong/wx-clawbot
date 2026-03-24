import Conf from "conf";
import type { UserConfigEntry } from "./types.js";

export const store = new Conf<{
    botToken: string;
    accountId: string;
    baseUrl: string;
    userId: string;
    updatesBuf: string;
    lastEventAt: number;
    userEntry: UserConfigEntry;
    contextToken: string;
}>({ projectName: "wx-self-bot" });
