import { useEffect, useRef, useState } from "react";
import { copyText } from "../lib/clipboard.ts";
import { IconCopy, IconCheck } from "../lib/icons.tsx";

// A small "copy to clipboard" button shown under a message's text. Click copies
// the raw message text (the markdown source the user typed / the agent sent),
// then flips to a ✓ "Copied" state for ~1.5s so the tap is acknowledged on
// devices with no hover affordance. Falls back to the legacy clipboard path on
// plain-HTTP origins (see lib/clipboard.ts).
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  async function onCopy() {
    const ok = await copyText(text);
    if (!ok) return;
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  }

  return (
    <button
      type="button"
      className={"msg-copy" + (copied ? " copied" : "")}
      onClick={onCopy}
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
    >
      {copied ? <IconCheck /> : <IconCopy />}
      <span className="msg-copy-label">{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}
