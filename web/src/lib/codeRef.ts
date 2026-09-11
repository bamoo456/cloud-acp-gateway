import { resolveWorkspaceRef } from "./api.ts";

// A place in the code an answer points at. `path` is the only required part:
// a file-level reference has no line, and a symbol is a display label whose
// underlying reference still has to say which file it is in.
export interface CodeRef {
  label?: string;
  path: string;
  line?: number;
  endLine?: number;
  column?: number;
  symbol?: string;
}

// What the text of an answer is allowed to look like to count as a reference:
// an absolute path, a `./`-style one, a repo path with a slash in it, or a bare
// filename — the last two ending in an extension, so "and/or" and "e.g" are
// left alone. Followed by an optional `:line`, `:line-end`, `:line:col`, or the
// `#L1-L2` fragment the viewer's own "add lines" chip emits. A match may not
// start mid-word, mid-path or after a colon, which is what keeps the tail of a
// URL from being read as a path of its own.
//
// A bare filename is also what a bare domain looks like, and this rule runs
// ahead of linkify (see markdown.ts). So a filename may not hold an `@`, start
// with `www.`, end in a gTLD no source file uses, or stop short of a further
// `.word` — `me@x.com`, `www.x.com/y.git`, `socket.io` and `docs.example.com`
// all stay linkify's. ponytail: `example.com/docs/index.html` is still read as
// a path; a scheme-less host with a path is the known ceiling.
const SEG = "[\\w.@+-]*[\\w@+-]";
const NAMED = "[\\w+-][\\w.+-]*\\.(?!(?:com|net|org|io)\\b)[A-Za-z]\\w*";
const PATH = `(?:\\.{1,2}/(?:${SEG}/)*${SEG}|/(?:${SEG}/)+${SEG}|(?:${SEG}/)+${NAMED}|${NAMED})`;
const LOC = "(?::(\\d+)(?::(\\d+)|-(\\d+))?|#L(\\d+)(?:-L(\\d+))?)?";
const REF = `(?<![\\w./:@+\\\\-])(?!www\\.)${PATH}${LOC}(?![\\w/]|\\.\\w)`;
export const CODE_REF_RE = new RegExp(REF, "g");
const WHOLE_RE = new RegExp(`^${REF}$`);

// The captures of CODE_REF_RE as a CodeRef.
export function refFromMatch(m: RegExpMatchArray): CodeRef {
  const [text, line, col, end, hashLine, hashEnd] = m;
  const path = text.slice(0, line ? text.indexOf(":") : hashLine ? text.indexOf("#") : text.length);
  const ref: CodeRef = { path };
  const start = Number(line || hashLine);
  if (start) ref.line = start;
  const last = Number(end || hashEnd);
  if (last && last >= start) ref.endLine = last;
  if (col) ref.column = Number(col);
  return ref;
}

// The whole of `text` as a reference, or null — for inline code and link
// targets, where a path with anything else around it is not one.
export function parseCodeRef(text: string): CodeRef | null {
  const m = WHOLE_RE.exec(text);
  return m ? refFromMatch(m) : null;
}

export interface ResolvedRef { abs: string; path: string }

// Answers are re-rendered on every streamed chunk, so the same reference is
// looked at many times over: one request per (cwd, path), and a null is kept
// too — the misses ("e.g", "Node.js") are the ones that recur most.
const cache = new Map<string, ResolvedRef | null>();
const inflight = new Map<string, Promise<ResolvedRef | null>>();
const key = (cwd: string, path: string) => cwd + "\0" + path;

// Synchronous, so a re-render can restore the affordance before paint.
export function lookupRef(cwd: string, path: string): ResolvedRef | null | undefined {
  return cache.get(key(cwd, path));
}

export function resolveRef(cwd: string, path: string): Promise<ResolvedRef | null> {
  const k = key(cwd, path);
  const hit = cache.get(k);
  if (hit !== undefined) return Promise.resolve(hit);
  let p = inflight.get(k);
  if (!p) {
    p = resolveWorkspaceRef(cwd, path).then((r) => { cache.set(k, r); inflight.delete(k); return r; });
    inflight.set(k, p);
  }
  return p;
}
