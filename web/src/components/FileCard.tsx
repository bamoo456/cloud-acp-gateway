import { useState } from "react";
import { useStore } from "../store/store.ts";
import { fileKind, fileKindLabel } from "../lib/fileKind.ts";
import { downloadFile } from "../lib/download.ts";
import { rawFileUrl } from "../lib/api.ts";
import { basename } from "../lib/format.ts";
import { fileIcon, IconDownload, IconSpinner } from "../lib/icons.tsx";

// A file an agent produced, as a card in the thread rather than a path in a
// line of monospace. The tool call already says "wrote report.sql"; this makes
// that sentence into the thing itself — click it to read the file, or save it
// without leaving the conversation.
//
// The card is deliberately only for files the agent WROTE. A read stays a plain
// path row: turning every consulted file into a card the size of this one would
// bury the actual output of a turn under its research.
export function FileCard({ path }: { path: string }) {
  const openFilePreview = useStore((s) => s.openFilePreview);
  const session = useStore((s) => (s.activeId ? s.sessions[s.activeId] : null));
  const storeCwd = useStore((s) => s.cwd);
  // Same rule as the panel: the file belongs to the *conversation's* folder, not
  // wherever the folder picker happens to be pointing.
  const cwd = session?.cwd || storeCwd;
  const name = basename(path);

  return (
    <div className="fcard">
      <button type="button" className="fcard-main" title={"Preview " + path}
        onClick={() => openFilePreview({ abs: path, path: name, mode: "diff" })}>
        <span className="fcard-icon">{fileIcon(fileKind(name).icon)}</span>
        <span className="fcard-text">
          <span className="fcard-name">{name}</span>
          <span className="fcard-kind">{fileKindLabel(name)}</span>
        </span>
      </button>
      <SaveButton url={rawFileUrl(cwd, path)} name={name} />
    </div>
  );
}

// "Download", not "Download and open": this saves through a blob URL (see
// lib/download.ts — a top-level navigation to an attachment tears the console
// down inside the native client's WKWebView), and a blob save cannot then hand
// the file to another app. Promising "and open" would be promising something
// the browser will not do.
function SaveButton({ url, name }: { url: string; name: string }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    // `failed` is a class, not just a tooltip: a title attribute says nothing on
    // a touch device, and the commonest failure here (a file outside
    // ACPG_FS_ROOT) otherwise looks exactly like a button that does nothing.
    <button type="button" className={"fcard-dl" + (failed ? " failed" : "")} disabled={busy}
      title={failed ? "Couldn't download this file — tap to retry" : "Download this file"}
      onClick={() => {
        if (busy) return;
        setBusy(true);
        setFailed(false);
        downloadFile(url, name).catch(() => setFailed(true)).finally(() => setBusy(false));
      }}>
      {busy ? <IconSpinner /> : <IconDownload />}
      <span>Download</span>
    </button>
  );
}
