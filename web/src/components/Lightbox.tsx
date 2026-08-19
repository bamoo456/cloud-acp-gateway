import { useEffect } from "react";
import { IconX } from "../lib/icons.tsx";

// One picture, full size, over everything.
//
// Full-size viewing is an overlay inside the app rather than target="_blank":
// the panel is narrow and a screenshot is the thing you most want to zoom into,
// but a new-window request in the native client's WKWebView has nowhere to go —
// silently dropped when the host app implements no UI delegate, and navigating
// away from the console when it does.
export function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  // Escape closes it, as it does every other overlay here. A picture opened by a
  // stray tap on a phone is closed by tapping it; on a desktop the hand is
  // already on the keyboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="wf-lightbox" role="dialog" aria-label={alt} onClick={onClose}>
      <img src={src} alt={alt} />
      <button type="button" className="icon-btn" title="Close" onClick={onClose}><IconX /></button>
    </div>
  );
}
