import { useEffect, useState } from "react";
import { useStore } from "../store/store.ts";
import { FolderBrowser } from "./FolderBrowser.tsx";
import { basename, timeAgo } from "../lib/format.ts";
import { readRecentFolders } from "../lib/recentFolders.ts";
import { getPinnedFolders, togglePinnedFolder } from "../lib/api.ts";
import { IconFolder, IconStar, IconChevronRight } from "../lib/icons.tsx";

const RECENT_LIMIT = 5;

function FolderRow({ path, when, pinned, current, onPick, onToggle }: {
  path: string; when?: string; pinned: boolean; current: boolean;
  onPick: (p: string) => void; onToggle: (p: string) => void;
}) {
  return (
    <button className={"arow" + (current ? " cur" : "")} onClick={() => onPick(path)}>
      <IconFolder />
      <span className="col"><span className="nm">{basename(path)}</span><span className="sub">{path}</span></span>
      {when && <span className="when">{when}</span>}
      <span className="star" role="button" aria-label={pinned ? "Unpin folder" : "Pin folder"}
        onClick={(e) => { e.stopPropagation(); onToggle(path); }}>
        <IconStar filled={pinned} />
      </span>
    </button>
  );
}

// Folder switcher — pinned/recent for one-tap switching, drill-down browser as
// fallback. A bottom sheet on mobile, a modal on desktop (CSS-driven, .amenu).
export function FolderPicker({ onClose }: { onClose: () => void }) {
  const s = useStore();
  const [browsing, setBrowsing] = useState(false);
  // Favorites live on the server now (shared across devices/IPs); load on mount.
  const [pinned, setPinned] = useState<string[]>([]);

  useEffect(() => { getPinnedFolders().then(setPinned).catch(() => {}); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const recents = readRecentFolders().filter((r) => !pinned.includes(r.path)).slice(0, RECENT_LIMIT);
  const pick = (p: string) => { useStore.getState().setCwd(p); onClose(); };
  const toggle = (p: string) => { togglePinnedFolder(p).then(setPinned).catch(() => {}); };

  if (browsing) {
    return <FolderBrowser onUse={pick} onBack={() => setBrowsing(false)} onClose={onClose} />;
  }
  return (
    <>
      <div className="amenu-scrim open" onClick={onClose} />
      <div className="amenu fp" role="menu">
        <div className="ahead">Folder<span className="fp-root">root: {s.cfg.fsRoot}</span></div>
        {pinned.length > 0 && (
          <div className="fp-pinned">
            <div className="fp-sec">Pinned</div>
            {pinned.map((p) => (
              <FolderRow key={p} path={p} pinned current={p === s.cwd} onPick={pick} onToggle={toggle} />
            ))}
          </div>
        )}
        {recents.length > 0 && (
          <div className="fp-recent">
            <div className="fp-sec">Recent</div>
            {recents.map((r) => (
              <FolderRow key={r.path} path={r.path} when={timeAgo(r.lastUsedAt)} pinned={false}
                current={r.path === s.cwd} onPick={pick} onToggle={toggle} />
            ))}
          </div>
        )}
        <div className="fp-sec">Locations</div>
        <button className="arow" onClick={() => setBrowsing(true)}>
          <IconFolder />
          <span className="col"><span>Browse all folders…</span><span className="sub">{s.cfg.fsRoot}</span></span>
          <span className="gt"><IconChevronRight /></span>
        </button>
      </div>
    </>
  );
}
