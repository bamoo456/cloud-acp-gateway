// Shared SSE+POST client for the e2e tests (not bundled into production — only the
// *.test.ts files import it). Mirrors what a real browser client does: open an SSE
// stream for the agent->client direction and POST client->agent frames to rpcPath.
import http from "node:http";

export const USER = "u";
export const TOKEN = "t";

export type Evt = { id: number | null; event: string; data: string };

// A minimal SSE client over a raw HTTP GET: parses id:/event:/data: blocks, skips
// keepalive comments, resolves `conn` from the `ready` event, and lets a test await
// the next data frame matching a predicate.
export function sse(port: number, opts: { agent?: string; lastEventId?: string } = {}) {
  let buf = "";
  const frames: Evt[] = [];
  const waiters: Array<{ pred: (e: Evt) => boolean; resolve: (e: Evt) => void }> = [];
  let resolveConn!: (id: string) => void;
  const conn = new Promise<string>((r) => { resolveConn = r; });

  const headers: Record<string, string> = { accept: "text/event-stream" };
  if (opts.lastEventId !== undefined) headers["last-event-id"] = opts.lastEventId;

  const req = http.get(
    `http://127.0.0.1:${port}/acp/sse?user=${USER}&token=${TOKEN}&agent=${opts.agent ?? "claude"}`,
    { headers },
    (res) => {
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          handleBlock(buf.slice(0, i));
          buf = buf.slice(i + 2);
        }
      });
    },
  );

  function handleBlock(block: string): void {
    let id: number | null = null;
    let event = "message";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue; // keepalive / comment
      else if (line.startsWith("id:")) id = Number(line.slice(3));
      else if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5);
    }
    if (event === "ready") { try { resolveConn(JSON.parse(data).conn as string); } catch { /* ignore */ } return; }
    if (event === "message" && data === "") return; // a bare keepalive block
    const e: Evt = { id, event, data };
    frames.push(e);
    for (let k = waiters.length - 1; k >= 0; k--) {
      if (waiters[k].pred(e)) { waiters[k].resolve(e); waiters.splice(k, 1); }
    }
  }

  return {
    conn,
    frames,
    next(pred: (e: Evt) => boolean): Promise<Evt> {
      const hit = frames.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve) => waiters.push({ pred, resolve }));
    },
    close() { req.destroy(); },
  };
}

// POST one JSON-RPC frame upstream; resolves with the HTTP status code.
export function post(port: number, conn: string, frame: unknown, agent = "claude"): Promise<number> {
  return new Promise((resolve, reject) => {
    const body = typeof frame === "string" ? frame : JSON.stringify(frame);
    const req = http.request(
      `http://127.0.0.1:${port}/acp/rpc?user=${USER}&token=${TOKEN}&agent=${agent}&conn=${encodeURIComponent(conn)}`,
      { method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
      (res) => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); },
    );
    req.on("error", reject);
    req.end(body);
  });
}

// Open an SSE GET with arbitrary query/headers and resolve only the HTTP status code
// (then drop the connection). Used by the auth tests.
export function sseStatus(port: number, query: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/acp/sse?${query}`, { headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
      req.destroy();
    });
    req.on("error", () => resolve(0));
  });
}

export const parseFrame = (s: string) => JSON.parse(s) as Record<string, unknown>;
