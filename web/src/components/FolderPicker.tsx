import { useEffect, useState } from "react";
import { useStore } from "../store/store.ts";
import { FolderBrowser } from "./FolderBrowser.tsx";
import { basename, timeAgo } from "../lib/format.ts";
import { readRecentFolders } from "../lib/recentFolders.ts";
import { getPinnedFolders, togglePinnedFolder } from "../lib/api.ts";
import { folderKey, homeFrom } from "../lib/folderKey.ts";
import { IconFolder, IconStar, IconHide, IconChevronRight } from "../lib/icons.tsx";

const RECENT_LIMIT = 5;

// The hide affordance is opt-in per section: Recent rows hide, HIDDEN rows
// un-hide, Pinned rows get nothing (hiding a folder you pinned contradicts
// itself, and two right-edge buttons on a phone row is already tight). Passing
// no `onToggleHide` is what leaves it off; `hidden` only picks the label.
function FolderRow({ path, when, pinned, current, hidden, onPick, onToggle, onToggleHide }: {
  path: string; when?: string; pinned: boolean; current: boolean; hidden: boolean;
  onPick: (p: string) => void; onToggle: (p: string) => void; onToggleHide?: (p: string) => void;
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
      {onToggleHide && (
        <span className="hide" role="button" aria-label={hidden ? "Unhide folder" : "Hide folder"}
          onClick={(e) => { e.stopPropagation(); onToggleHide(path); }}>
          <IconHide />
        </span>
      )}
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

  const home = homeFrom(s.cwd, s.cfg.fsRoot, s.cfg.agents[0]?.cwd);
  const hiddenKeys = new Set(s.hiddenFolders.map((h) => folderKey(h, home)));
  const isHidden = (p: string) => hiddenKeys.has(folderKey(p, home));
  const pinnedKeys = new Set(pinned.map((p) => folderKey(p, home)));
  // A folder appears in exactly one section: hidden folders drop out of
  // Pinned/Recent (compared by folderKey, not raw spelling).
  const visiblePinned = pinned.filter((p) => !isHidden(p));
  const recents = readRecentFolders()
    .filter((r) => !pinned.includes(r.path) && !isHidden(r.path))
    .slice(0, RECENT_LIMIT);
  const pick = (p: string) => { useStore.getState().setCwd(p); onClose(); };
  const toggle = (p: string) => { togglePinnedFolder(p).then(setPinned).catch(() => {}); };
  const toggleHide = (p: string) => s.toggleHiddenFolder(p);

  if (browsing) {
    return <FolderBrowser onUse={pick} onBack={() => setBrowsing(false)} onClose={onClose} />;
  }
  return (
    <>
      <div className="amenu-scrim open" onClick={onClose} />
      <div className="amenu fp" role="menu">
        <div className="ahead">Folder<span className="fp-root">root: {s.cfg.fsRoot}</span></div>
        {visiblePinned.length > 0 && (
          <div className="fp-pinned">
            <div className="fp-sec">Pinned</div>
            {visiblePinned.map((p) => (
              <FolderRow key={p} path={p} pinned current={p === s.cwd} hidden={false}
                onPick={pick} onToggle={toggle} />
            ))}
          </div>
        )}
        {recents.length > 0 && (
          <div className="fp-recent">
            <div className="fp-sec">Recent</div>
            {/* hideFolders() always exempts the folder you're working in, so the
                row for it offers no hide — the toggle would look broken. */}
            {recents.map((r) => (
              <FolderRow key={r.path} path={r.path} when={timeAgo(r.lastUsedAt)} pinned={false}
                current={r.path === s.cwd} hidden={false} onPick={pick} onToggle={toggle}
                onToggleHide={r.path === s.cwd ? undefined : toggleHide} />
            ))}
          </div>
        )}
        {s.hiddenFolders.length > 0 && (
          <div className="fp-hidden">
            <div className="fp-sec">Hidden</div>
            {s.hiddenFolders.map((p) => (
              <FolderRow key={p} path={p} pinned={pinnedKeys.has(folderKey(p, home))} current={p === s.cwd} hidden
                onPick={pick} onToggle={toggle} onToggleHide={toggleHide} />
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
