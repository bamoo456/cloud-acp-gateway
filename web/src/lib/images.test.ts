import { describe, test, expect } from "vitest";
import { imageSrc, isSupportedImage, readImageFile, MAX_IMAGE_BYTES } from "./images.ts";

describe("image helpers", () => {
  test("imageSrc builds a data URL for inline bytes, else uses the uri", () => {
    expect(imageSrc({ mimeType: "image/png", data: "AAAA" })).toBe("data:image/png;base64,AAAA");
    expect(imageSrc({ mimeType: "image/png", uri: "https://x/y.png" })).toBe("https://x/y.png");
    expect(imageSrc({ mimeType: "image/png" })).toBe("");
  });

  test("isSupportedImage allows common raster types only", () => {
    expect(isSupportedImage("image/png")).toBe(true);
    expect(isSupportedImage("image/jpeg")).toBe(true);
    expect(isSupportedImage("image/svg+xml")).toBe(false);
    expect(isSupportedImage("application/pdf")).toBe(false);
  });

  test("readImageFile reads a small image into raw base64 (no data: prefix)", async () => {
    // 1x1 transparent PNG
    const b64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const file = new File([bytes], "dot.png", { type: "image/png" });
    const img = await readImageFile(file);
    expect(img.mimeType).toBe("image/png");
    expect(img.data).toBe(b64);
  });

  test("readImageFile rejects unsupported types", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "x.pdf", { type: "application/pdf" });
    await expect(readImageFile(file)).rejects.toThrow(/Unsupported/);
  });

  test("readImageFile rejects oversized images", async () => {
    const big = { type: "image/png", size: MAX_IMAGE_BYTES + 1 } as unknown as File;
    await expect(readImageFile(big)).rejects.toThrow(/too large/);
  });
});
