import type { MessageImage } from "../types.ts";

// Per-image cap. Base64-inlined images travel inside the JSON-RPC frame and are
// appended to the gateway ledger, so an oversized paste/drop would bloat both the
// upstream POST body (ACPG_MAX_PAYLOAD, 16 MiB default) and the ledger. Reject
// early with a clear message instead of failing on send.
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MiB

// Image MIME types we let through the composer. Mirrors what the common agents
// (Claude, Codex) accept; anything else is dropped with a hint.
const ALLOWED = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function isSupportedImage(type: string): boolean {
  return ALLOWED.has(type);
}

// A data: URL for rendering an image block in an <img src>. Falls back to the
// resource uri when the block carries a link instead of inline bytes.
export function imageSrc(img: MessageImage): string {
  if (img.data) return "data:" + img.mimeType + ";base64," + img.data;
  return img.uri || "";
}

// Read a File/Blob into a MessageImage (raw base64, no data: prefix). Rejects
// unsupported types and anything over MAX_IMAGE_BYTES.
export function readImageFile(file: File | Blob): Promise<MessageImage> {
  const type = file.type || "image/png";
  if (!isSupportedImage(type)) {
    return Promise.reject(new Error("Unsupported image type: " + type));
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return Promise.reject(new Error("Image is too large (max " + Math.round(MAX_IMAGE_BYTES / (1024 * 1024)) + " MiB)."));
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("Couldn't read image."));
    reader.onload = () => {
      const result = String(reader.result || "");
      // strip the "data:<mime>;base64," prefix — we send raw base64 to the agent
      const comma = result.indexOf(",");
      const data = comma >= 0 ? result.slice(comma + 1) : result;
      if (!data) { reject(new Error("Couldn't read image.")); return; }
      resolve({ mimeType: type, data });
    };
    reader.readAsDataURL(file);
  });
}
