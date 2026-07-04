import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Session, MessageImage, MessageFile } from "../types.ts";
import { useStore } from "../store/store.ts";
import { imageSrc } from "../lib/images.ts";
import { IconFile } from "../lib/icons.tsx";
import { Markdown } from "./Markdown.tsx";
import { ToolCall } from "./ToolCall.tsx";
import { Plan } from "./Plan.tsx";
import { PermissionPrompt } from "./PermissionPrompt.tsx";
import { Working } from "./Working.tsx";
import { CopyButton } from "./CopyButton.tsx";
import { CodexMark, IconChevronDown, IconThinking, OpencodeMark, Robot } from "../lib/icons.tsx";

// Mount only the most recent slice of a conversation. Every rendered message adds
// DOM nodes (a code block becomes hundreds), and the browser's per-keystroke layout
// pass scales with the live node count — a long thread froze the composer for >1s
// per keystroke. Older items stay in the store and are revealed as the user scrolls
// up toward the top, a window at a time.
const INITIAL_VISIBLE = 10;
const REVEAL_STEP = 20;
const NEAR_TOP_PX = 300;

// Inline images attached to a user or agent message. Click opens the full-size
// image in a new tab (handy for screenshots/mockups).
function MessageImages({ images }: { images: MessageImage[] }) {
  return (
    <div className="msg-images">
      {images.map((img, i) => {
        const src = imageSrc(img);
        return <a className="msg-image" key={i} href={src} target="_blank" rel="noreferrer"><img src={src} alt={"image " + (i + 1)} /></a>;
      })}
    </div>
  );
}

// Files referenced via "@ file" in a user message, rendered as compact chips
// (the path, not a bare string). A file:// uri can't be opened from the browser,
// so the chip is non-interactive — it just shows what context was sent.
function MessageFiles({ files }: { files: MessageFile[] }) {
  return (
    <div className="msg-files">
      {files.map((f, i) => (
        <span className="file-chip" key={i} title={f.uri || f.name}>
          <IconFile /><span className="nm">{f.name}</span>
        </span>
      ))}
    </div>
  );
}

// Pin the scroll container to the bottom *instantly* — bypassing the container's
// CSS `scroll-behavior: smooth`, whose animation chases a moving target while
// markdown/tool cards are still laying out and otherwise settles part-way up.
function jumpToBottom(m: HTMLElement) {
  const prev = m.style.scrollBehavior;
  m.style.scrollBehavior = "auto";
  m.scrollTop = m.scrollHeight;
  m.style.scrollBehavior = prev;
}

// Force WebKit to repaint the scroll container after a large reflow. iOS Safari /
// PWA WebViews intermittently leave the thread composited-but-not-painted when the
// turn's working indicator is replaced by a tool card or permission prompt, so it
// shows blank until a touch-driven scroll nudges the compositor (issue #98). The
// scroll-to-bottom effects only move `scrollTop`, which is a no-op (and so triggers
// no repaint) when already pinned to the bottom. Toggling a compositing hint for one
// frame forces the recomposite; `translateZ(0)` is a visual identity, so nothing
// jumps, and it works regardless of scroll position.
function forceRepaint(m: HTMLElement) {
  const prev = m.style.transform;
  m.style.transform = "translateZ(0)";
  requestAnimationFrame(() => { m.style.transform = prev; });
}

export function Thread({ session, agentReady, loading }: { session: Session | null; agentReady: boolean; loading?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const hiddenRef = useRef(0);      // latest hidden count, read inside the (once-bound) scroll handler
  const anchorHeight = useRef(0);   // scrollHeight captured before a reveal, to compensate the prepend
  const agent = useStore((s) => s.cfg.agents.find((a) => a.name === s.agentName));
  const [visible, setVisible] = useState(INITIAL_VISIBLE);
  // Show a "jump to latest" button whenever the user has scrolled up off the bottom,
  // so they can return to the live tail in one tap instead of a long manual scroll.
  const [showJump, setShowJump] = useState(false);

  const sid = session?.id ?? null;
  // Reset the window when switching conversations.
  useEffect(() => { setVisible(INITIAL_VISIBLE); }, [sid]);

  // One scroll listener on the scroll container: track whether we're pinned to the
  // bottom (so streaming keeps following) and reveal older messages when the user
  // nears the top.
  useEffect(() => {
    const m = ref.current?.closest("main");
    if (!m) return;
    const onScroll = () => {
      atBottom.current = m.scrollHeight - m.scrollTop - m.clientHeight < 80;
      setShowJump(!atBottom.current);
      if (m.scrollTop < NEAR_TOP_PX && hiddenRef.current > 0 && anchorHeight.current === 0) {
        anchorHeight.current = m.scrollHeight; // remember height so we can hold the viewport steady
        setVisible((v) => v + REVEAL_STEP);
      }
    };
    m.addEventListener("scroll", onScroll, { passive: true });
    return () => m.removeEventListener("scroll", onScroll);
  }, []);

  // After a reveal prepends older messages, keep the viewport on the same content by
  // adding the height they introduced. Must be instant (not the CSS smooth scroll),
  // and runs before paint so there is no visible jump.
  useLayoutEffect(() => {
    const m = ref.current?.closest("main");
    if (!m || !anchorHeight.current) return;
    const prev = m.style.scrollBehavior;
    m.style.scrollBehavior = "auto";
    m.scrollTop += m.scrollHeight - anchorHeight.current;
    m.style.scrollBehavior = prev;
    anchorHeight.current = 0;
  }, [visible]);

  // Follow new content to the bottom only when the user is already pinned there, so
  // scrolling up to read (or revealing earlier messages) is never yanked back down.
  useEffect(() => {
    if (!atBottom.current) return;
    const m = ref.current?.closest("main");
    if (m) m.scrollTop = m.scrollHeight;
  });

  const hasContent = !!session?.hasContent;
  // joining a shared (deep-link) conversation: show a clear loading state instead
  // of a blank screen or a misleading "Ready to code?" flash
  const showLoading = !!loading && !hasContent;
  const showEmpty = !showLoading && agentReady && (!session || !hasContent);
  const items = session?.items ?? [];
  const hidden = Math.max(0, items.length - visible);
  hiddenRef.current = hidden;
  const shown = hidden > 0 ? items.slice(-visible) : items;

  // Opening (or loading) a conversation should land on the latest message. The
  // follow-effect above can fall short here: the first jump fires while markdown,
  // code blocks and tool cards are still laying out (worse on mobile), and the
  // container's CSS smooth scroll animates toward a target that keeps growing — so
  // it settles part-way up. Jump instantly and re-assert over the next two frames
  // once layout has settled. Keyed on the session and on content first appearing
  // (a deep-link join paints empty, then fills), not on every streamed chunk.
  useEffect(() => {
    if (!hasContent) return;
    const m = ref.current?.closest("main");
    if (!m) return;
    const toBottom = () => {
      jumpToBottom(m);
      atBottom.current = true; // keep the follow-effect pinned for incoming chunks
    };
    toBottom();
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => { toBottom(); raf2 = requestAnimationFrame(toBottom); });
    return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); };
  }, [sid, hasContent]);

  // A permission prompt is a blocking, must-answer event, and its arrival is a big
  // layout shift: the turn's working indicator is removed and the prompt appended.
  // The smooth-scroll follow-effect can undershoot that, stranding the prompt above
  // the fold with blank space below (issue #50 — "scroll up to see it"). When a new
  // prompt lands at the tail, force it into view instantly and re-assert across two
  // frames once its buttons have laid out — regardless of where the user had scrolled.
  const tail = items[items.length - 1];
  const tailPermId = tail?.kind === "permission" ? tail.id : null;
  useEffect(() => {
    if (!tailPermId) return;
    const m = ref.current?.closest("main");
    if (!m) return;
    const toBottom = () => { jumpToBottom(m); atBottom.current = true; };
    toBottom();
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => { toBottom(); raf2 = requestAnimationFrame(toBottom); });
    return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); };
  }, [tailPermId]);

  // Independent of where the viewport sits, force a repaint on every *structural*
  // change to the thread — an item added (tool card, permission prompt, message),
  // the working indicator toggling, or a session switch. This is the actual fix for
  // the "blank until you swipe" symptom (issue #98); the scroll effects above only
  // handle position.
  //
  // Crucially, a running tool mutates its card *in place* — status goes
  // pending → in_progress → completed/failed and result blocks are appended — all
  // without changing the item count, yet each is a big reflow that can strand the
  // thread blank mid-execution (the "still blank while a tool runs" report after the
  // first fix). So the key folds in each tool's status and content-block count, not
  // just the item count. Streamed assistant/thought text still mutates an item in
  // place without adding blocks, so it doesn't fire this — keeping repaints bounded.
  const structuralSig = items
    .map((it) => (it.kind === "tool" ? `t${it.status}.${it.content.length}` : it.kind))
    .join("|");
  const working = !!session?.working;
  useEffect(() => {
    const m = ref.current?.closest("main");
    if (m) forceRepaint(m as HTMLElement);
  }, [structuralSig, working, sid]);

  // Tap the floating arrow to return to the live tail. Pin instantly (the smooth
  // scroll chases a still-growing target while a turn streams) and mark us as
  // pinned so the follow-effect keeps tracking incoming chunks. Re-assert over the
  // next two frames as well: markdown/code/tool cards and pending images can still
  // be settling, growing scrollHeight after the first jump lands — so a single jump
  // sometimes stops short of the true bottom (it "doesn't always go all the way").
  const jumpLatest = () => {
    const m = ref.current?.closest("main");
    if (!m) return;
    const toBottom = () => { jumpToBottom(m); atBottom.current = true; };
    toBottom();
    requestAnimationFrame(() => { toBottom(); requestAnimationFrame(toBottom); });
    setShowJump(false);
  };

  return (
    <div className="thread" ref={ref}>
      {showLoading && (
        <div className="empty"><span className="spinner" /><h2>Joining conversation…</h2><p>Loading the shared session.</p></div>
      )}
      {showEmpty && (
        <div className="empty">{agent?.skin === "codex" ? <CodexMark /> : agent?.kind === "opencode" ? <OpencodeMark /> : <Robot />}<h2>Ready to code?</h2><p>Let&apos;s write something worth deploying.</p></div>
      )}
      {hidden > 0 && (
        <div className="earlier-hint">↑ Scroll up for {hidden} earlier message{hidden === 1 ? "" : "s"}</div>
      )}
      {shown.map((it) => {
        switch (it.kind) {
          case "user": return (
            <div className="msg user" key={it.id}>
              <div className="bubble rich">
                {it.images && it.images.length > 0 && <MessageImages images={it.images} />}
                {it.files && it.files.length > 0 && <MessageFiles files={it.files} />}
                {it.text && <Markdown text={it.text} />}
              </div>
              {it.text && <CopyButton text={it.text} label="Copy message" />}
            </div>
          );
          case "assistant": return (
            <div className="msg assistant" key={it.id}>
              {it.images && it.images.length > 0 && <MessageImages images={it.images} />}
              {it.text && <Markdown text={it.text} />}
              {it.text && <CopyButton text={it.text} label="Copy reply" />}
            </div>
          );
          case "thought": return (
            <details className="thinking" key={it.id}>
              <summary><IconThinking />Thinking</summary><Markdown text={it.text} />
            </details>
          );
          case "tool": return <ToolCall item={it} key={it.id} />;
          case "plan": return <Plan entries={it.entries} key={it.id} />;
          case "permission": return <PermissionPrompt item={it} key={it.id} />;
          case "note": return <div className={it.variant === "error" ? "err-line" : "loc"} key={it.id}>{it.text}</div>;
        }
      })}
      {session?.working && <Working />}
      {showJump && hasContent && (
        <div className="jump-latest-wrap">
          <button type="button" className="jump-latest" onClick={jumpLatest} aria-label="Scroll to latest message" title="Scroll to latest message">
            <IconChevronDown />
          </button>
        </div>
      )}
    </div>
  );
}
