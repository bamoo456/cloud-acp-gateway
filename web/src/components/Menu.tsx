export interface MenuItem { key: string; name: string; description?: string; selected?: boolean; }
export function Menu({ open, items, empty, onPick }: { open: boolean; items: MenuItem[]; empty: string; onPick: (k: string) => void }) {
  return (
    <div className={"cmds" + (open ? " open" : "")}>
      {items.length === 0 && <div className="panel-empty">{empty}</div>}
      {items.map((it) => (
        <button key={it.key} className={it.selected ? "sel" : ""} onClick={() => onPick(it.key)}>
          <span className="col"><span className="cn">{it.name}</span>{it.description && <span className="cd">{it.description}</span>}</span>
          {it.selected && <span className="ck">✓</span>}
        </button>
      ))}
    </div>
  );
}
