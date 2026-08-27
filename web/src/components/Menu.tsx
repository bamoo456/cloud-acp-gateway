import { useEffect, useRef } from "react";

export interface MenuItem { key: string; name: string; description?: string; selected?: boolean; }
export function Menu({ open, items, empty, onPick }: { open: boolean; items: MenuItem[]; empty: string; onPick: (k: string) => void }) {
  const selRef = useRef<HTMLButtonElement>(null);
  const selected = items.find((it) => it.selected)?.key;
  // Arrow/Tab navigation walks a list far longer than the menu's scroll box (a
  // Claude session exposes a hundred-plus skills), so without this the selection
  // moves invisibly below the fold and Enter picks something off-screen.
  // "nearest" so a selection already in view doesn't jerk the page around it.
  useEffect(() => {
    if (open) selRef.current?.scrollIntoView({ block: "nearest" });
  }, [open, selected]);
  return (
    <div className={"cmds" + (open ? " open" : "")}>
      {items.length === 0 && <div className="panel-empty">{empty}</div>}
      {items.map((it) => (
        <button key={it.key} ref={it.selected ? selRef : undefined} className={it.selected ? "sel" : ""} onClick={() => onPick(it.key)}>
          <span className="col"><span className="cn">{it.name}</span>{it.description && <span className="cd">{it.description}</span>}</span>
          {it.selected && <span className="ck">✓</span>}
        </button>
      ))}
    </div>
  );
}
