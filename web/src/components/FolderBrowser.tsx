import { useEffect, useRef, useState, type TouchEvent as ReactTouchEvent } from "react";
import { listDir, type FsResult } from "../lib/api.ts";
import { useStore } from "../store/store.ts";
import { basename } from "../lib/format.ts";
import { IconBack, IconFolder } from "../lib/icons.tsx";

// Tail-preserving display: the folder name matters more than the prefix.
function shortPath(p: string) {
  if (p.length <= 34) return p;
  return "…/" + p.split("/").filter(Boolean).slice(-2).join("/");
}

// Page stack from fsRoot down to cwd, so the browser opens "where you are".
function seedStack(root: string, cwd: string): string[] {
  const base = root.replace(/\/+$/, "") || "/";
  const baseWithSlash = base === "/" ? "/" : base + "/";
  if (!cwd || (cwd !== base && !cwd.startsWith(baseWithSlash))) return [base];
  const stack = [base];
  let acc = base === "/" ? "" : base;
  for (const seg of cwd.slice(base.length).split("/").filter(Boolean)) {
    acc += "/" + seg;
    stack.push(acc);
  }
  return stack;
}

function joinPath(parent: string, name: string) {
  return (parent === "/" ? "" : parent.replace(/\/+$/, "")) + "/" + name;
}

function Page({ path, top, filter, onPush, animate }: {
  path: string; top: boolean; filter: string; onPush: (p: string) => void; animate: boolean;
}) {
  const [data, setData] = useState<FsResult | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    let live = true;
    setData(null); setErr(false);
    listDir(path).then((d) => { if (live) setData(d); }).catch(() => live && setErr(true));
    return () => { live = false; };
  }, [path]);
  const dirs = (data?.dirs || []).filter((d) => d.name.toLowerCase().includes(filter.toLowerCase()));
  return (
    <div className={"bp" + (top ? " top" : " under") + (animate ? " enter" : "")}>
      {!data && !err && <div className="panel-empty">Loading…</div>}
      {err && <div className="panel-empty">Couldn't list folder.</div>}
      {data && !err && dirs.length === 0 && (
        <div className="panel-empty">{filter ? "No matching folders" : "No subfolders"}</div>
      )}
      {dirs.map((d) => (
        <button className="dir" key={d.name} tabIndex={top ? 0 : -1} onClick={() => top && onPush(joinPath(path, d.name))}>
          <span className="fi"><IconFolder /></span>
          <span className="nm">{d.name}</span>
          {d.git && <span className="git">git</span>}
        </button>
      ))}
    </div>
  );
}

export function FolderBrowser({ onUse, onBack, onClose }: {
  onUse: (path: string) => void; onBack: () => void; onClose: () => void;
}) {
  const s = useStore();
  const [stack, setStack] = useState<string[]>(() => seedStack(s.cfg.fsRoot || "/", s.cwd));
  const [filter, setFilter] = useState("");
  // path of a page sliding out after pop; cleared when its exit animation ends
  const [leaving, setLeaving] = useState<string | null>(null);
  // distinguishes a freshly pushed page (animates in) from a page re-exposed by pop
  const pushed = useRef(false);
  const pagesRef = useRef<HTMLDivElement | null>(null);
  const swipe = useRef<{ x0: number; dx: number } | null>(null);
  const leaveTimer = useRef<number | null>(null);
  useEffect(() => () => { if (leaveTimer.current !== null) window.clearTimeout(leaveTimer.current); }, []);
  const top = stack[stack.length - 1];
  const parent = stack.length > 1 ? stack[stack.length - 2] : null;

  // Esc cancels the whole picker flow
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  // entering a new level always starts unfiltered
  useEffect(() => { setFilter(""); }, [stack.length]);

  const push = (p: string) => { pushed.current = true; setLeaving(null); setStack((st) => [...st, p]); };
  const pop = () => {
    if (stack.length <= 1) { onBack(); return; }
    pushed.current = false;
    setLeaving(stack[stack.length - 1]);
    setStack((st) => st.slice(0, -1));
    if (leaveTimer.current !== null) window.clearTimeout(leaveTimer.current);
    leaveTimer.current = window.setTimeout(() => { leaveTimer.current = null; setLeaving(null); }, 260);
  };

  const topPageEl = () => pagesRef.current?.querySelector<HTMLElement>(".bp.top") ?? null;
  const underPageEl = () => pagesRef.current?.querySelector<HTMLElement>(".bp.under") ?? null;
  const onTouchStart = (e: ReactTouchEvent<HTMLDivElement>) => {
    if (stack.length < 2 || !pagesRef.current) return;
    const x = e.touches[0].clientX;
    if (x - pagesRef.current.getBoundingClientRect().left > 32) return;
    swipe.current = { x0: x, dx: 0 };
  };
  const onTouchMove = (e: ReactTouchEvent<HTMLDivElement>) => {
    if (!swipe.current || !pagesRef.current) return;
    const dx = Math.max(0, e.touches[0].clientX - swipe.current.x0);
    swipe.current.dx = dx;
    const w = pagesRef.current.clientWidth;
    const topEl = topPageEl(); const underEl = underPageEl();
    if (topEl) { topEl.style.transition = "none"; topEl.style.transform = `translateX(${dx}px)`; }
    if (underEl) { underEl.style.transition = "none"; underEl.style.transform = `translateX(${-30 + 30 * Math.min(1, dx / w)}%)`; }
  };
  const onTouchEnd = () => {
    if (!swipe.current || !pagesRef.current) return;
    const { dx } = swipe.current;
    swipe.current = null;
    const w = pagesRef.current.clientWidth;
    const topEl = topPageEl(); const underEl = underPageEl();
    // hand transforms back to the stylesheet before React swaps classes
    if (topEl) { topEl.style.transition = ""; topEl.style.transform = ""; }
    if (underEl) { underEl.style.transition = ""; underEl.style.transform = ""; }
    if (dx > w * 0.32) pop();
  };

  return (
    <>
      <div className="fb-scrim" onClick={onClose} />
      <div id="fb" className="open">
        <div className="fb-nav">
          <button className="fb-back" onClick={pop}>
            <IconBack /><span className="lbl">{parent ? basename(parent) : "Folders"}</span>
          </button>
          <span className="fb-title">{basename(top)}</span>
          <span className="fb-nav-pad" aria-hidden />
        </div>
        <div className="fb-filter">
          <input placeholder="Filter folders" value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <div className="fb-pages" ref={pagesRef}
          onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd} onTouchCancel={onTouchEnd}>
          {stack.slice(-2).map((p) => (
            <Page key={p} path={p} top={p === top} filter={p === top ? filter : ""} onPush={push}
              animate={p === top && pushed.current} />
          ))}
          {leaving && <div className="bp exit" aria-hidden />}
        </div>
        <div className="fb-foot">
          <span className="path">{shortPath(top)}</span>
          <button className="btn primary" onClick={() => onUse(top)}>Use this folder</button>
        </div>
      </div>
    </>
  );
}
