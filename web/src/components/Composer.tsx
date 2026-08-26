import { useRef, useState, useEffect } from "react";
import { branchGate, hasCodexSkin, useStore, engineOf } from "../store/store.ts";
import { Menu } from "./Menu.tsx";
import { IconSlash, IconSend, IconStop, IconAt, IconFile, IconGitBranch, IconClock } from "../lib/icons.tsx";
import { readImageFile, imageSrc } from "../lib/images.ts";
import { activeMention, replaceMention, makeMessageFile } from "../lib/mentions.ts";
import { activeCommand, filterCommands, commandToken } from "../lib/commands.ts";
import { MarkdownInput, type MarkdownInputHandle, type MarkdownInputCallbacks } from "./MarkdownInput.tsx";
import { listFiles, uploadFile } from "../lib/api.ts";
import type { MessageImage, MessageFile, QueuedPrompt } from "../types.ts";

// Touch / coarse-pointer devices (phones, tablets) have no Shift key on their
// virtual keyboard, so there is no way to type Shift+Enter for a newline. On
// those devices Enter must insert a newline and submission happens via the
// Send button instead. Desktop keeps Enter=submit, Shift+Enter=newline.
const isTouchDevice = typeof window !== "undefined" &&
  (window.matchMedia?.("(pointer: coarse)").matches || "ontouchstart" in window);

// What a queued message reads as on the rail. An image- or file-only message has
// no text of its own, and rendering it as an empty row would look like a bug —
// name what it carries instead, in the same mono voice the rail's labels use.
function queuedText(q: QueuedPrompt): string {
  if (q.text.trim()) return q.text;
  const carried = [
    q.images?.length ? q.images.length + (q.images.length > 1 ? " images" : " image") : "",
    q.files?.length ? q.files.map((f) => f.name).join(", ") : "",
  ].filter(Boolean);
  return carried.join(" · ");
}

export function Composer({ sessionId, compact }: { sessionId?: string; compact?: boolean } = {}) {
  const mi = useRef<MarkdownInputHandle>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const slashRef = useRef<HTMLButtonElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const fileMenuRef = useRef<HTMLDivElement>(null);
  const atRef = useRef<HTMLButtonElement>(null);
  const [text, setText] = useState("");
  const [images, setImages] = useState<MessageImage[]>([]);
  const [uploading, setUploading] = useState(0); // in-flight /uploads count
  const [dragging, setDragging] = useState(false);
  // slash-command menu: query is null when closed, "" when opened via the button
  // (show all), else the substring typed after "/". `cmdActive` is the keyboard
  // selection into the filtered list.
  const [cmdQuery, setCmdQuery] = useState<string | null>(null);
  const [cmdActive, setCmdActive] = useState(0);
  // "@ file" picker: query is null when closed, else the substring after "@".
  const [fileQuery, setFileQuery] = useState<string | null>(null);
  const [fileItems, setFileItems] = useState<string[]>([]);
  const [fileActive, setFileActive] = useState(0);
  // Branching is one click from a control that sits next to send, and it spends a
  // few seconds spawning a CLI — cheap to undo, but not free to trigger by
  // accident. So the first click only arms it: the button says what will happen
  // and waits for a second one. `armed` holds the timer that gives up on its own.
  const [armed, setArmed] = useState(false);
  const s = useStore();
  // A bound instance (the branch window) targets a conversation that isn't the
  // store's active one, so its file references can't live in the store's
  // `attachedFiles` list — that list stays global on purpose (the file panel
  // writes into it) and keeps feeding the unbound composer only. Local state
  // stands in for it here, with the same dedup-on-uri / by-index semantics as
  // the store's attachFiles/removeAttachedFile/clearAttachedFiles.
  const [localFiles, setLocalFiles] = useState<MessageFile[]>([]);
  const files = sessionId ? localFiles : s.attachedFiles;
  const attach = sessionId
    ? (added: MessageFile[]) => setLocalFiles((prev) => {
        const next = [...prev];
        for (const f of added) if (!next.some((p) => p.uri === f.uri)) next.push(f);
        return next;
      })
    : s.attachFiles;
  const removeAt = sessionId ? (i: number) => setLocalFiles((prev) => prev.filter((_, idx) => idx !== i)) : s.removeAttachedFile;
  const clearFiles = sessionId ? () => setLocalFiles([]) : s.clearAttachedFiles;
  // The conversation this composer talks to: its own, when bound (the branch
  // window), else whichever one is on screen.
  const targetId = sessionId ?? s.activeId;
  const activeBusy = !!(targetId && s.busySessionIds[targetId]);
  // Messages typed into this conversation while its turn was running, waiting for
  // that turn to end (store.ts's queuedPrompts).
  const queued = (targetId && s.queuedPrompts[targetId]) || [];
  const branch = branchGate(s);
  const canAttachImages = !!s.promptCapabilities.image;
  // "@ file" references ride on embeddedContext (the agent accepts resource blocks).
  const canReferenceFiles = !!s.promptCapabilities.embeddedContext;
  const hasContent = !!text.trim() || images.length > 0 || files.length > 0;
  // Mid-turn the button queues instead of sending, but it wants exactly the same
  // things: something to say, an agent to say it to, no upload still landing.
  const canSend = hasContent && s.agentReady && !uploading;
  // A branch is a send into a conversation that does not exist yet, so it wants
  // the same thing send does: something to say. A branch of a conversation
  // mid-turn is refused by branchGate anyway.
  const branchable = canSend;
  // Mid-turn with something ready to send, the stop button becomes interrupt.
  const cutting = activeBusy && canSend;
  const placeholder = hasCodexSkin(s) ? "Reply to Codex…" : "Reply to Claude…";
  const fileMenuOpen = fileQuery !== null && fileItems.length > 0;
  // Commands filtered by what's been typed after "/". The menu is shown whenever
  // a query is set (open), even if nothing matches, so the "no commands" hint
  // stays visible while the user edits.
  // This conversation's own commands: a bound instance (a floating window) is a
  // different session, and available_commands_update is per session like every
  // other engine list (store.ts's engineOf).
  const commands = engineOf(s, sessionId).commands;
  const cmdItems = cmdQuery === null ? [] : filterCommands(commands, cmdQuery);
  const cmdMenuOpen = cmdQuery !== null;
  // Codex exposes skills as "$name" commands; only then does a leading "$"
  // open the command menu, so other agents don't pop it on a "$..." message.
  const hasSkillCommands = commands.some((c) => c.name.startsWith("$"));

  // dismiss the slash menu on a pointer down outside it (and outside its toggle).
  // The editor keeps it open so typing "/…" doesn't dismiss mid-pick; Esc and
  // keyboard nav are handled in the editor's keymap.
  useEffect(() => {
    if (!cmdMenuOpen) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || slashRef.current?.contains(t) || editorRef.current?.contains(t)) return;
      setCmdQuery(null);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [cmdMenuOpen]);

  // Keep the keyboard selection in range as the filtered list shrinks/grows.
  useEffect(() => { setCmdActive(0); }, [cmdQuery]);

  // dismiss the file menu on a pointer down outside it (the editor and the "@"
  // toggle keep it open so typing / clicking them doesn't dismiss mid-pick).
  useEffect(() => {
    if (fileQuery === null) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (fileMenuRef.current?.contains(t) || editorRef.current?.contains(t) || atRef.current?.contains(t)) return;
      setFileQuery(null);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [fileQuery]);

  // Fetch matching files (debounced) whenever the "@ token" query changes. A
  // sequence guard drops stale responses so fast typing lands on the right list.
  useEffect(() => {
    if (fileQuery === null) { setFileItems([]); return; }
    let live = true;
    const t = setTimeout(() => {
      listFiles(s.cwd, fileQuery)
        .then((f) => { if (live) { setFileItems(f); setFileActive(0); } })
        .catch(() => { if (live) setFileItems([]); });
    }, 120);
    return () => { live = false; clearTimeout(t); };
  }, [fileQuery, s.cwd]);

  // Open/close the "@ file" menu based on whether the caret sits inside an "@"
  // token. Disabled when the agent can't take file references.
  function syncMention(value: string, caret: number) {
    if (!canReferenceFiles) { setFileQuery(null); return; }
    const m = activeMention(value, caret);
    setFileQuery(m ? m.query : null);
  }

  // Open/filter the slash-command menu while the caret sits inside a leading
  // "/command" token, closing it once the text no longer starts a command. A
  // menu opened via the button (query "") stays open until you type past the
  // token or dismiss it.
  function syncCommand(value: string, caret: number) {
    const c = activeCommand(value, caret, hasSkillCommands);
    setCmdQuery(c ? c.query : null);
  }

  // The editor reports every text/caret change here — keep React's mirror of the
  // value in sync and re-evaluate whether a menu should be open.
  function onEditorChange(value: string, caret: number) {
    setText(value);
    syncMention(value, caret);
    syncCommand(value, caret);
    setArmed(false); // going back to typing is an answer: not now
  }

  // An armed branch button gives up by itself, and on Escape. Both because the
  // arming is a question nobody has to answer: leaving a primed control sitting
  // there is how a stray later click becomes a fork nobody asked for.
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 3000);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setArmed(false); };
    document.addEventListener("keydown", onKey);
    return () => { clearTimeout(timer); document.removeEventListener("keydown", onKey); };
  }, [armed]);

  // Pick a command: replace the leading "/command" (or "$skill") token the user
  // is editing with the picked token (or insert it when the menu was opened with
  // empty input), then restore focus + caret after the inserted command. `token`
  // already carries its "/"/"$" prefix.
  function pickCommand(token: string) {
    const caret = mi.current?.getCaret() ?? text.length;
    const c = activeCommand(text, caret, hasSkillCommands);
    const after = c ? text.slice(c.end) : text;
    const insert = token + (after.startsWith(" ") ? "" : " ");
    const nt = insert + after;
    setCmdQuery(null);
    mi.current?.setValue(nt, insert.length);
    mi.current?.focus();
  }

  // Read dropped/pasted/picked files into image attachments, surfacing the first
  // failure (unsupported type / too large) as a tip instead of silently dropping.
  async function addFiles(files: FileList | File[] | null | undefined) {
    if (!canAttachImages || !files) return;
    const picks = Array.from(files).filter((f) => f.type.startsWith("image/"));
    if (!picks.length) return;
    const added: MessageImage[] = [];
    for (const f of picks) {
      try { added.push(await readImageFile(f)); }
      catch (e) { s.setTip(e instanceof Error ? e.message : "Couldn't add image."); }
    }
    if (added.length) setImages((prev) => [...prev, ...added]);
  }

  // Upload one or more picked files (any type — md, pdf, whatever) to the
  // gateway and add each as a "files" reference: identical wire shape to an
  // "@ file" pick (a resource_link the agent reads itself), just sourced from
  // an upload instead of the project tree. Sequential, like addFiles, so an
  // earlier failure's tip isn't clobbered by a later one resolving first.
  async function addUploadedFiles(list: FileList | File[] | null | undefined) {
    if (!canReferenceFiles || !list) return;
    const picks = Array.from(list);
    if (!picks.length) return;
    for (const f of picks) {
      setUploading((n) => n + 1);
      try {
        attach([await uploadFile(f)]);
      } catch (e) {
        s.setTip(e instanceof Error ? e.message : "Couldn't upload the file.");
      } finally {
        setUploading((n) => n - 1);
      }
    }
  }

  // One picker for everything, because two were indistinguishable on the
  // devices this gateway is actually driven from: iOS shows the same "Take
  // Photo / Photo Library / Choose File" sheet for an accept="image/*" input
  // as for an unrestricted one, so a separate image button bought nothing but
  // a second identical sheet. What comes back decides the route instead —
  // images keep the zero-round-trip inline path (thumbnail preview, an ACP
  // image block), everything else is uploaded and referenced as a
  // resource_link. Both sub-handlers re-check their own capability, so this
  // only has to explain the drop.
  async function addAttachments(list: FileList | File[] | null | undefined) {
    if (!list) return;
    const picks = Array.from(list);
    const imgs = picks.filter((f) => f.type.startsWith("image/"));
    const rest = picks.filter((f) => !f.type.startsWith("image/"));
    if (imgs.length && !canAttachImages) s.setTip("This agent doesn't accept image attachments.");
    else if (rest.length && !canReferenceFiles) s.setTip("This agent doesn't accept file attachments.");
    // Concurrently: they touch disjoint state (images vs files), and serializing
    // would park a document upload behind a FileReader pass over a large photo
    // for no reason.
    await Promise.all([addFiles(imgs), addUploadedFiles(rest)]);
  }

  function removeImage(i: number) { setImages((prev) => prev.filter((_, idx) => idx !== i)); }

  function addReferencedFile(rel: string) {
    attach([makeMessageFile(s.cwd, rel)]);
  }

  // Pick a file from the "@" menu: drop the "@token" from the text (the file shows
  // as a removable chip instead) and add the reference. Restore focus + caret.
  function pickFile(rel: string) {
    const caret = mi.current?.getCaret() ?? text.length;
    const m = activeMention(text, caret);
    if (m) {
      const { text: nt, caret: nc } = replaceMention(text, m, caret, "");
      mi.current?.setValue(nt, nc);
    }
    mi.current?.focus();
    addReferencedFile(rel);
    setFileQuery(null);
  }

  // The "@" button inserts an "@" at the caret and opens the picker — same path as
  // typing "@", but discoverable for users who don't know the shortcut.
  function openFileMenu() {
    const caret = mi.current?.getCaret() ?? text.length;
    const nt = text.slice(0, caret) + "@" + text.slice(caret);
    mi.current?.setValue(nt, caret + 1);
    setFileQuery("");
    mi.current?.focus();
  }

  // Branching sends: the message in the box becomes the new branch's first turn,
  // which is what gives it a transcript and a place in the sidebar. The box is
  // only cleared once the fork has actually landed — until then this is the only
  // copy of what was typed, and the tip explaining the failure is no use to
  // someone whose paragraph just vanished.
  async function branchWith() {
    if (uploading) return;
    const t = text; const imgs = images; const refs = files;
    if (!t.trim() && !imgs.length && !refs.length) return;
    if (await s.branchSession({ text: t, images: imgs, files: refs })) {
      setText(""); setImages([]); clearFiles(); setFileQuery(null); setCmdQuery(null);
    }
  }

  function submit() {
    // Enter bypasses the Send button's `disabled={!canSend}`, so it needs its own
    // guard: sending mid-upload would clear `files` out from under the pending
    // upload, and the file would land as a chip on the *next* message instead.
    if (uploading) return;
    const t = text; const imgs = images; const refs = files;
    // Enter on an empty box mid-turn keeps its old meaning: stop. With something
    // typed, Enter QUEUES — interrupting is the button beside it, because cutting a
    // running turn should cost a deliberate tap rather than a reflex keystroke.
    if (!t.trim() && !imgs.length && !refs.length) { if (activeBusy) stop(); return; }
    setText(""); setImages([]); clearFiles(); setFileQuery(null); setCmdQuery(null);
    // The box is cleared above, so from here the store holds the only copy either
    // way — queuePrompt keeps it until the running turn ends.
    if (activeBusy && targetId) s.queuePrompt(targetId, { text: t, images: imgs, files: refs });
    else if (sessionId) s.sendPromptTo(sessionId, t, imgs, refs);
    else s.sendPrompt(t, imgs, refs);
  }

  // Stop takes the queue back rather than firing it or dropping it: a deliberate
  // stop that then sent the next message anyway is the surprising outcome, and
  // silently binning what was typed is the unforgivable one. Text lands back in
  // the box; attachments are named in it, since chips can't be reconstructed from
  // a queued item's uploads.
  // Cut the running turn short and send what is typed as the next one. The queue
  // is left alone on purpose: an interrupt says "this one first", not "forget the
  // rest" — those go out after this new turn, in the order they were typed.
  function interrupt() {
    if (!targetId || !canSend) return;
    const t = text; const imgs = images; const refs = files;
    setText(""); setImages([]); clearFiles(); setFileQuery(null); setCmdQuery(null);
    s.interruptWith(targetId, { text: t, images: imgs, files: refs });
  }

  // The queue comes back BEFORE the cancel is sent, not after: a cancel that
  // throws (a socket that just went) would otherwise leave the messages parked
  // against a turn nobody is going to end. A stop that failed can be pressed
  // again; typed text that was dropped on the way is gone.
  function stop() {
    if (targetId) {
      const back = s.takeQueuedPrompts(targetId);
      if (back.length) setText([text.trim(), ...back.map(queuedText)].filter(Boolean).join("\n\n"));
    }
    s.cancel(sessionId);
  }

  // Live callbacks the editor's keymap reads (rebuilt each render so they close
  // over the current menu state). The arrow/enter/tab/esc handlers return true
  // only when a menu consumes the key, so normal editing falls through.
  const callbacksRef = useRef<MarkdownInputCallbacks>(null as unknown as MarkdownInputCallbacks);
  callbacksRef.current = {
    isTouch: isTouchDevice,
    onSubmit: submit,
    onMenuEnter: () => {
      // The "@" menu picks on Enter on every device; the slash menu only on
      // desktop (touch has no Shift+Enter, so Enter stays a newline there).
      if (fileMenuOpen) { pickFile(fileItems[fileActive]); return true; }
      if (cmdMenuOpen && cmdItems.length > 0 && !isTouchDevice) { pickCommand(commandToken(cmdItems[cmdActive])); return true; }
      return false;
    },
    onArrow: (dir) => {
      if (cmdMenuOpen && cmdItems.length > 0) { setCmdActive((i) => (i + dir + cmdItems.length) % cmdItems.length); return true; }
      if (fileMenuOpen) { setFileActive((i) => (i + dir + fileItems.length) % fileItems.length); return true; }
      return false;
    },
    onTab: () => {
      if (cmdMenuOpen && cmdItems.length > 0) { pickCommand(commandToken(cmdItems[cmdActive])); return true; }
      if (fileMenuOpen) { pickFile(fileItems[fileActive]); return true; }
      return false;
    },
    onEscape: () => {
      if (cmdMenuOpen && cmdItems.length > 0) { setCmdQuery(null); return true; }
      if (fileMenuOpen) { setFileQuery(null); return true; }
      return false;
    },
  };

  return (
    <footer>
      <div ref={menuRef}>
        <Menu open={cmdMenuOpen} empty="No matching commands."
          items={cmdItems.map((c, i) => ({ key: commandToken(c), name: commandToken(c), description: c.description, selected: i === cmdActive }))}
          onPick={pickCommand} />
      </div>
      <div ref={fileMenuRef}>
        <Menu open={fileMenuOpen} empty="No matching files."
          items={fileItems.map((f, i) => ({ key: f, name: f, selected: i === fileActive }))}
          onPick={pickFile} />
      </div>
      {s.tip && (
        <div className="tipbar" style={{ display: "flex" }}>
          <span id="tip-text">{s.tip}</span>
          <button className="x icon-btn" style={{ width: 26, height: 26 }} onClick={() => s.setTip("")}>✕</button>
        </div>
      )}
      {/* The send queue, drawn as what it is: a dashed line running down into the
          composer with a hollow node per waiting message. It sits in the footer
          rather than in the thread because the line has to reach the box those
          messages came out of — in the scroller it would drift away from it. */}
      {queued.length > 0 && (
        <div className="queue-rail">
          {queued.map((q, i) => (
            <div className="queue-item" key={q.id}>
              <div className="queue-meta">
                <span>next {i + 1}</span>
                <span className="sp" />
                <button className="x" title="Remove queued message"
                  aria-label={"Remove queued message " + (i + 1)}
                  onClick={() => targetId && s.unqueuePrompt(targetId, q.id)}>✕</button>
              </div>
              <div className="queue-body">{queuedText(q)}</div>
            </div>
          ))}
          <div className="queue-out">sends in order, one per turn</div>
        </div>
      )}
      <div
        className={"composer" + (compact ? " compact" : "") + (dragging ? " dragover" : "")}
        onDragOver={canAttachImages ? (e) => { e.preventDefault(); setDragging(true); } : undefined}
        onDragLeave={canAttachImages ? () => setDragging(false) : undefined}
        onDrop={canAttachImages ? (e) => { e.preventDefault(); setDragging(false); void addFiles(e.dataTransfer?.files); } : undefined}
      >
        {images.length > 0 && (
          <div className="attachments">
            {images.map((img, i) => (
              <div className="thumb" key={i}>
                <img src={imageSrc(img)} alt={"attachment " + (i + 1)} />
                <button className="thumb-x" title="Remove image" onClick={() => removeImage(i)}>✕</button>
              </div>
            ))}
          </div>
        )}
        {files.length > 0 && (
          <div className="file-chips">
            {files.map((f, i) => (
              <span className="file-chip" key={f.uri || f.name} title={f.uri || f.name}>
                <IconFile /><span className="nm">{f.name}</span>
                {f.range && <span className="rng">{f.range}</span>}
                <button className="chip-x" title="Remove file" onClick={() => removeAt(i)}>✕</button>
              </span>
            ))}
          </div>
        )}
        {/* editorRef wraps the editor so the outside-click handlers can tell a
            click landed inside it (the menus keep open when it does). */}
        <div ref={editorRef}>
          <MarkdownInput ref={mi} className="cm-input" value={text} placeholder={placeholder}
            onChange={onEditorChange}
            onPasteFiles={canAttachImages ? (fs) => void addFiles(fs) : undefined}
            callbacksRef={callbacksRef} />
        </div>
        <div className="crow">
          <button ref={slashRef} className="cbtn" title="Slash commands" onClick={() => {
            if (cmdMenuOpen) { setCmdQuery(null); return; }
            // Open filtered to a command already being typed, else show all.
            const caret = mi.current?.getCaret() ?? text.length;
            const c = activeCommand(text, caret, hasSkillCommands);
            setCmdQuery(c ? c.query : "");
            mi.current?.focus();
          }}><IconSlash /></button>
          {canReferenceFiles && (
            <button ref={atRef} className="cbtn" title="Reference a file" onClick={openFileMenu}><IconAt /></button>
          )}
          {(canAttachImages || canReferenceFiles) && (
            <button className="cbtn" title="Attach" disabled={uploading > 0}
              onClick={() => fileRef.current?.click()}><IconFile /></button>
          )}
          <input ref={fileRef} type="file" multiple hidden
            onChange={(e) => { void addAttachments(e.target.files); e.target.value = ""; }} />
          {armed && !branch.disabled && (
            <span className="branch-hint">branch this conversation? click again · Esc cancels</span>
          )}
          <span className="spacer" />
          {/* Beside send, wearing send's shape in outline — the same trick
              `.send.stop` uses to say "same control, not the primary one". Never
              rendered in a bound instance: the branch window's own composer would
              be offering to branch the conversation BEHIND it. */}
          {!sessionId && branch.show && (
            <button className={"send branch-btn" + (armed ? " armed" : " ghost")}
              title={armed ? "Click again to branch" : branchable ? branch.why : "Type the message to open the branch with"}
              aria-label={armed ? "Confirm branching this conversation" : "Branch conversation"}
              disabled={branch.disabled || !branchable}
              onClick={() => {
                if (!armed) { setArmed(true); return; }
                setArmed(false);
                void branchWith();
              }}>
              <IconGitBranch />{armed ? "confirm" : "branch"}
            </button>
          )}
          {/* Mid-turn there are two buttons, not one wearing two hats — a phone has
              no second gesture for stop, so it keeps its own. This one is always
              "cut the running turn": on its own with an empty box, and carrying
              what is typed when there is something to send. Gated on canSend, not
              on the text alone, so an upload still landing leaves it plain stop
              rather than an interrupt that cannot fire. */}
          {activeBusy && (cutting
            ? <button className="send stop" title="Interrupt and send now" onClick={interrupt}><IconStop />interrupt</button>
            : <button className="send stop" title="Stop" onClick={stop}><IconStop />stop</button>
          )}
          <button className="send" title={activeBusy ? "Queue for after this turn" : "Send"}
            disabled={!canSend} onClick={submit}>
            {activeBusy ? <>queue<IconClock /></> : <>send<IconSend /></>}
          </button>
        </div>
      </div>
    </footer>
  );
}
