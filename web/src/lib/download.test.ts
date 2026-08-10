import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import { downloadFile } from "./download.ts";

describe("downloadFile", () => {
  let created: string[];
  let revoked: string[];
  let clicked: HTMLAnchorElement[];

  beforeEach(() => {
    created = [];
    revoked = [];
    clicked = [];
    vi.useFakeTimers();
    (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = () => {
      const u = "blob:mock/" + created.length;
      created.push(u);
      return u;
    };
    (URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = (u) => { revoked.push(u); };
    // jsdom doesn't implement navigation, so a real anchor click would warn and
    // do nothing observable — record the click instead.
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) { clicked.push(this); };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(["hello"]) }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  test("saves through a blob anchor and never navigates the page", async () => {
    await downloadFile("/workspace/raw?path=/repo/report.pdf", "report.pdf");

    expect(fetch).toHaveBeenCalledWith("/workspace/raw?path=/repo/report.pdf");
    expect(clicked).toHaveLength(1);
    // The download attribute plus a blob: href is what keeps WebKit from
    // treating this as a top-level navigation to an attachment (error 102).
    expect(clicked[0].getAttribute("download")).toBe("report.pdf");
    expect(clicked[0].getAttribute("href")).toBe(created[0]);
    // location is untouched — the whole point of the exercise.
    expect(location.href).not.toContain("workspace/raw");
  });

  test("leaves no anchor behind in the document", async () => {
    await downloadFile("/raw", "a.bin");
    expect(document.querySelectorAll("a[download]")).toHaveLength(0);
  });

  test("defers revoking the object URL so it can't cancel the save it started", async () => {
    await downloadFile("/raw", "a.bin");
    expect(revoked).toEqual([]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(revoked).toEqual([created[0]]);
  });

  test("rejects on a failed response instead of saving an error page", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, blob: async () => new Blob() }));
    await expect(downloadFile("/raw", "a.bin")).rejects.toThrow(/download/i);
    expect(clicked).toHaveLength(0);
  });
});
