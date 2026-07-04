// Per-agent durable transcript of every agent→client frame, the backbone of
// reconnect/resync. Each frame gets a server-assigned monotonic sequence id (seq)
// that is decoupled from its array position, so the ledger can later be trimmed or
// rotated without shifting the cursor a client resumes from. A client persists its
// last-seen seq and resumes with "give me everything after seq N" — see Gateway.attach.
//
// On-disk format (JSONL), one entry per line:
//   v2: {"s":<seq>,"sid":<string|null>,"f":<frame-as-string>}
//   v1 (legacy): a bare JSON-RPC frame; assigned a seq by load order so existing
//       ledgers keep working (their implicit position == the seq they get).
// New appends always write v2; a mixed file (v1 prefix + v2 suffix) loads correctly
// because v2 seqs continue from where the v1 lines left off.
import fs from "node:fs";
import path from "node:path";
import { parse, sessionIdOf } from "./frames.ts";

export interface LedgerEntry {
  seq: number;
  sid: string | null;
  frame: Buffer;
}

// Retention caps. 0/absent = unbounded (the historical behavior). When either is
// exceeded the oldest entries are trimmed, raising floorSeq so a client resuming
// from below the retained window is told to full-reload instead of replayed a gap.
export interface LedgerLimits { maxFrames?: number; maxBytes?: number }

function envLimits(): LedgerLimits {
  const num = (v?: string) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0; };
  return {
    maxFrames: num(process.env.ACPG_LEDGER_MAX_FRAMES),
    maxBytes: num(process.env.ACPG_LEDGER_MAX_BYTES),
  };
}

export class Ledger {
  private entries: LedgerEntry[] = [];
  private bySession = new Map<string, number[]>(); // sid -> ascending seqs (per-session index)
  private fd: number;
  private nextSeq = 1;
  private bytes = 0;       // sum of in-memory frame byte lengths (for the byte cap)
  private deadOnDisk = 0;  // trimmed lines still physically in the file (reset by rotate)
  private readonly maxFrames: number;
  private readonly maxBytes: number;

  constructor(private p: string, limits: LedgerLimits = envLimits()) {
    this.maxFrames = limits.maxFrames ?? 0;
    this.maxBytes = limits.maxBytes ?? 0;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (fs.existsSync(p)) this.loadFile(fs.readFileSync(p));
    // Synchronous appends (vs a WriteStream) so rotation — close the fd, rename a
    // compacted file into place, reopen — never races a lazily-opened stream fd.
    this.fd = fs.openSync(p, "a");
    // A ledger that's already over cap on load (cap lowered, or a long-running file
    // bounded for the first time) is trimmed and compacted at startup, so we never
    // hold — or re-replay across a restart — more than the cap.
    if (this.overCap()) { this.trim(); this.rotate(); }
  }

  private loadFile(data: Buffer): void {
    let start = 0;
    for (let i = 0; i <= data.length; i++) {
      if (i === data.length || data[i] === 0x0a /* \n */) {
        if (i > start) this.ingestLine(data.subarray(start, i));
        start = i + 1;
      }
    }
  }

  // Distinguish a v2 envelope from a legacy v1 raw frame: only the envelope carries
  // a numeric `s` plus a string `f`. No ACP frame has both at the top level.
  private ingestLine(line: Buffer): void {
    const o = parse(line);
    if (o && typeof o.s === "number" && typeof o.f === "string") {
      const sid = typeof o.sid === "string" ? o.sid : null;
      this.add(o.s, sid, Buffer.from(o.f, "utf8"));
    } else {
      // v1: the whole line is the frame. Copy it out of the read buffer (subarray is
      // a view) and assign the next seq by load order.
      this.add(this.nextSeq, o ? sessionIdOf(o) : null, Buffer.from(line));
    }
  }

  // Add an entry to the in-memory log + per-session index, advancing nextSeq past it.
  private add(seq: number, sid: string | null, frame: Buffer): LedgerEntry {
    const entry: LedgerEntry = { seq, sid, frame };
    this.entries.push(entry);
    this.bytes += frame.length;
    if (sid) (this.bySession.get(sid) ?? this.bySession.set(sid, []).get(sid)!).push(seq);
    if (seq >= this.nextSeq) this.nextSeq = seq + 1;
    return entry;
  }

  private serialize(e: LedgerEntry): string {
    return JSON.stringify({ s: e.seq, sid: e.sid, f: e.frame.toString("utf8") }) + "\n";
  }

  // Append an agent→client frame, persist it as a v2 line, and return its entry.
  // `sid` is the session the frame belongs to (null for responses / frames without
  // one), used for the per-session index. Enforces the retention caps afterwards.
  append(frame: Buffer, sid: string | null): LedgerEntry {
    const entry = this.add(this.nextSeq, sid, frame);
    fs.writeSync(this.fd, this.serialize(entry));
    this.enforceLimits();
    return entry;
  }

  private overCap(): boolean {
    return (this.maxFrames > 0 && this.entries.length > this.maxFrames) ||
           (this.maxBytes > 0 && this.bytes > this.maxBytes);
  }

  private enforceLimits(): void {
    if (!this.overCap()) return;
    this.trim();
    if (this.shouldRotate()) this.rotate();
  }

  // Drop oldest entries until within both caps, keeping at least one so floor/head stay
  // meaningful. Each drop raises floorSeq, leaves a dead line on disk, and removes the
  // (front, smallest) seq from its session index.
  private trim(): void {
    while (this.entries.length > 1 && this.overCap()) {
      const e = this.entries.shift()!;
      this.bytes -= e.frame.length;
      this.deadOnDisk++;
      if (e.sid) {
        const seqs = this.bySession.get(e.sid);
        if (seqs) { seqs.shift(); if (seqs.length === 0) this.bySession.delete(e.sid); }
      }
    }
  }

  // Compact once the file has at least doubled with dead lines, bounding it to ~2× the
  // live window. Cheap for small windows, rare for large ones.
  private shouldRotate(): boolean { return this.deadOnDisk >= this.entries.length; }

  // Rewrite the file to exactly the retained entries and keep appending to the fresh
  // file. The in-memory entries are the source of truth, so a crash mid-rotate at worst
  // leaves the pre-rotate file (a superset) — never a gap.
  private rotate(): void {
    const tmp = `${this.p}.compact.${process.pid}`;
    fs.writeFileSync(tmp, this.entries.map((e) => this.serialize(e)).join(""));
    fs.renameSync(tmp, this.p);
    fs.closeSync(this.fd);          // the old (now-replaced) inode
    this.fd = fs.openSync(this.p, "a"); // continue appending to the compacted file
    this.deadOnDisk = 0;
  }

  // Frames with seq > afterSeq, in order, optionally filtered to one session. This is
  // the resume window: a client reconnecting at cursor=N replays since(N).
  since(afterSeq: number, sid?: string): LedgerEntry[] {
    const out: LedgerEntry[] = [];
    for (const e of this.entries) {
      if (e.seq > afterSeq && (sid === undefined || e.sid === sid)) out.push(e);
    }
    return out;
  }

  // Smallest retained seq (0 when empty). A client resuming below floor-1 has missed
  // frames we no longer hold and must full-reload (the gateway sends _gateway/reload).
  floorSeq(): number {
    return this.entries.length ? this.entries[0].seq : 0;
  }

  // Latest assigned seq (0 before anything is appended). cursor=end maps to this:
  // since(headSeq()) is empty, i.e. live with no replay.
  headSeq(): number {
    return this.nextSeq - 1;
  }

  // Close the append fd. Used by tests (to read back a fresh load) and available for
  // graceful shutdown; the long-lived process never needs it. Writes are synchronous,
  // so there is nothing to flush — async for call-site compatibility.
  close(): Promise<void> {
    fs.closeSync(this.fd);
    return Promise.resolve();
  }
}
