import { useRef, useState, useEffect } from "react";
import { hasCodexSkin, useStore } from "../store/store.ts";
import { Menu } from "./Menu.tsx";
import { IconSlash, IconSend, IconStop, IconImage, IconAt, IconFile } from "../lib/icons.tsx";
import { readImageFile, imageSrc } from "../lib/images.ts";
import { activeMention, replaceMention, makeMessageFile } from "../lib/mentions.ts";
import { activeCommand, filterCommands, commandToken } from "../lib/commands.ts";
import { MarkdownInput, type MarkdownInputHandle, type MarkdownInputCallbacks } from "./MarkdownInput.tsx";
import { listFiles } from "../lib/api.ts";
import type { MessageImage, MessageFile } from "../types.ts";

// Touch / coarse-pointer devices (phones, tablets) have no Shift key on their
// virtual keyboard, so there is no way to type Shift+Enter for a newline. On
// those devices Enter must insert a newline and submission happens via the
// Send button instead. Desktop keeps Enter=submit, Shift+Enter=newline.
const isTouchDevice = typeof window !== "undefined" &&
  (window.matchMedia?.("(pointer: coarse)").matches || "ontouchstart" in window);

export function Composer() {
  const mi = useRef<MarkdownInputHandle>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const slashRef = useRef<HTMLButtonElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const fileMenuRef = useRef<HTMLDivElement>(null);
  const atRef = useRef<HTMLButtonElement>(null);
  const [text, setText] = useState("");
  const [images, setImages] = useState<MessageImage[]>([]);
  const [files, setFiles] = useState<MessageFile[]>([]); // "@ file" references
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
  const s = useStore();
  const activeBusy = !!(s.activeId && s.busySessionIds[s.activeId]);
  const canAttachImages = !!s.promptCapabilities.image;
  // "@ file" references ride on embeddedContext (the agent accepts resource blocks).
  const canReferenceFiles = !!s.promptCapabilities.embeddedContext;
  const canSend = activeBusy || ((!!text.trim() || images.length > 0 || files.length > 0) && s.agentReady);
  const placeholder = hasCodexSkin(s) ? "Reply to Codex…" : "Reply to Claude…";
  const fileMenuOpen = fileQuery !== null && fileItems.length > 0;
  // Commands filtered by what's been typed after "/". The menu is shown whenever
  // a query is set (open), even if nothing matches, so the "no commands" hint
  // stays visible while the user edits.
  const cmdItems = cmdQuery === null ? [] : filterCommands(s.commands, cmdQuery);
  const cmdMenuOpen = cmdQuery !== null;
  // Codex exposes skills as "$name" commands; only then does a leading "$"
  // open the command menu, so other agents don't pop it on a "$..." message.
  const hasSkillCommands = s.commands.some((c) => c.name.startsWith("$"));

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
  }

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

  function removeImage(i: number) { setImages((prev) => prev.filter((_, idx) => idx !== i)); }
  function removeFile(i: number) { setFiles((prev) => prev.filter((_, idx) => idx !== i)); }

  function addReferencedFile(rel: string) {
    const f = makeMessageFile(s.cwd, rel);
    setFiles((prev) => (prev.some((p) => p.uri === f.uri) ? prev : [...prev, f]));
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

  function submit() {
    if (activeBusy) { s.cancel(); return; }
    const t = text; const imgs = images; const refs = files;
    if (!t.trim() && !imgs.length && !refs.length) return;
    setText(""); setImages([]); setFiles([]); setFileQuery(null); setCmdQuery(null);
    s.sendPrompt(t, imgs, refs);
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
      <div
        className={"composer" + (dragging ? " dragover" : "")}
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
                <button className="chip-x" title="Remove file" onClick={() => removeFile(i)}>✕</button>
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
          {canAttachImages && (
            <button className="cbtn" title="Attach image" onClick={() => fileRef.current?.click()}><IconImage /></button>
          )}
          <input ref={fileRef} type="file" accept="image/*" multiple hidden
            onChange={(e) => { void addFiles(e.target.files); e.target.value = ""; }} />
          <span className="spacer" />
          <button className={"send" + (activeBusy ? " stop" : "")} title="Send" disabled={!canSend} onClick={submit}>
            {activeBusy ? <IconStop /> : <IconSend />}
          </button>
        </div>
      </div>
    </footer>
  );
}
