import crypto from "node:crypto";
import path from "node:path";

const EXTENSION_TO_MIME: Record<string, string> = {
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt": "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".txt": "text/plain",
    ".csv": "text/csv",
    ".zip": "application/zip",
    ".tar": "application/x-tar",
    ".gz": "application/gzip",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".wav": "audio/wav",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
};

const MIME_TO_EXTENSION: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
    "video/mp4": ".mp4",
    "video/quicktime": ".mov",
    "video/webm": ".webm",
    "video/x-matroska": ".mkv",
    "video/x-msvideo": ".avi",
    "audio/mpeg": ".mp3",
    "audio/ogg": ".ogg",
    "audio/wav": ".wav",
    "application/pdf": ".pdf",
    "application/zip": ".zip",
    "application/x-tar": ".tar",
    "application/gzip": ".gz",
    "text/plain": ".txt",
    "text/csv": ".csv",
};

const DEFAULT_BODY_MAX_LEN = 200;
const DEFAULT_TOKEN_PREFIX_LEN = 6;
export function truncate(s: string | undefined, max: number): string {
    if (!s) return "";
    if (s.length <= max) return s;
    return `${s.slice(0, max)}…(len=${s.length})`;
}

export function redactToken(token: string | undefined, prefixLen = DEFAULT_TOKEN_PREFIX_LEN): string {
    if (!token) return "(none)";
    if (token.length <= prefixLen) return `****(len=${token.length})`;
    return `${token.slice(0, prefixLen)}…(len=${token.length})`;
}
export function redactBody(body: string | undefined, maxLen = DEFAULT_BODY_MAX_LEN): string {
    if (!body) return "(empty)";
    if (body.length <= maxLen) return body;
    return `${body.slice(0, maxLen)}…(truncated, totalLen=${body.length})`;
}

export function redactUrl(rawUrl: string): string {
    try {
        const u = new URL(rawUrl);
        const base = `${u.origin}${u.pathname}`;
        return u.search ? `${base}?<redacted>` : base;
    } catch {
        return truncate(rawUrl, 80);
    }
}

export function generateId(prefix: string): string {
    return `${prefix}:${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

export function tempFileName(prefix: string, ext: string): string {
    return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}${ext}`;
}

export function getMimeFromFilename(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    return EXTENSION_TO_MIME[ext] ?? "application/octet-stream";
}

export function getExtensionFromMime(mimeType: string): string {
    const ct = mimeType.split(";")[0]!.trim().toLowerCase();
    return MIME_TO_EXTENSION[ct] ?? ".bin";
}

export function getExtensionFromContentTypeOrUrl(contentType: string | null, url: string): string {
    if (contentType) {
        const ext = getExtensionFromMime(contentType);
        if (ext !== ".bin") return ext;
    }
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    const knownExts = new Set(Object.keys(EXTENSION_TO_MIME));
    return knownExts.has(ext) ? ext : ".bin";
}

export function sleep(ms: number, abortSignal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
            resolve();
            abortSignal?.removeEventListener("abort", listener);
        }, ms);
        const listener = () => {
            abortSignal?.removeEventListener("abort", listener);
            clearTimeout(timeout);
            reject(new Error("aborted"));
        };
        abortSignal?.addEventListener("abort", listener);
    });
}

export function pcmBytesToWav(pcm: Uint8Array, sampleRate: number): Buffer {
    const pcmBytes = pcm.byteLength;
    const totalSize = 44 + pcmBytes;
    const buf = Buffer.allocUnsafe(totalSize);
    let offset = 0;

    buf.write("RIFF", offset);
    offset += 4;
    buf.writeUInt32LE(totalSize - 8, offset);
    offset += 4;
    buf.write("WAVE", offset);
    offset += 4;

    buf.write("fmt ", offset);
    offset += 4;
    buf.writeUInt32LE(16, offset);
    offset += 4; // fmt chunk size
    buf.writeUInt16LE(1, offset);
    offset += 2; // PCM format
    buf.writeUInt16LE(1, offset);
    offset += 2; // mono
    buf.writeUInt32LE(sampleRate, offset);
    offset += 4;
    buf.writeUInt32LE(sampleRate * 2, offset);
    offset += 4; // byte rate (mono 16-bit)
    buf.writeUInt16LE(2, offset);
    offset += 2; // block align
    buf.writeUInt16LE(16, offset);
    offset += 2; // bits per sample

    buf.write("data", offset);
    offset += 4;
    buf.writeUInt32LE(pcmBytes, offset);
    offset += 4;

    Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).copy(buf, offset);

    return buf;
}
