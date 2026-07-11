import { useId, type ReactElement } from "react";

// ---- header / panel icons ----

export function IconClock() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

export function IconPlus() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function IconDots() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" />
    </svg>
  );
}

export function IconPencil() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  );
}

export function IconType() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7V4h10v3" />
      <path d="M9 20V4" />
      <path d="M15 13v-2h5v2" />
      <path d="M17.5 20v-9" />
      <path d="M6 20h6" />
      <path d="M15 20h5" />
    </svg>
  );
}

export function IconShare() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 15V3M8 7l4-4 4 4" /><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" />
    </svg>
  );
}

export function IconFolder() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round">
      <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
    </svg>
  );
}

export function IconChevron() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
      <path d="M8 9l4-4 4 4M8 15l4 4 4-4" />
    </svg>
  );
}

export function IconBack() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 18l-6-6 6-6" />
    </svg>
  );
}

export function IconStar({ filled = false }: { filled?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" fill={filled ? "#e2b341" : "none"} stroke={filled ? "#e2b341" : "currentColor"} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" />
    </svg>
  );
}

export function IconChevronDown() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

export function IconChevronRight() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 6l6 6-6 6" />
    </svg>
  );
}

export function IconSlash() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="4" />
      <path d="M14 8l-4 8" />
    </svg>
  );
}

export function IconAt() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M16 8v5a3 3 0 006 0v-1a10 10 0 10-3.92 7.94" />
    </svg>
  );
}

export function IconFile() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}

export function IconModel() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
    </svg>
  );
}

export function IconShield() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

export function IconBolt() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z" />
    </svg>
  );
}

export function IconSend() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  );
}

export function IconStop() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <rect x="7" y="7" width="10" height="10" rx="2" />
    </svg>
  );
}

export function IconImage() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="M21 15l-5-5L5 21" />
    </svg>
  );
}

export function IconThinking() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18h6M10 22h4M12 2a7 7 0 00-4 12.7V17h8v-2.3A7 7 0 0012 2z" />
    </svg>
  );
}

export function IconCheck() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="#3a9b5c" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

export function IconX() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="#cf5b4e" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}

export function IconSpinner() {
  return (
    <svg className="spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
      <path d="M21 12a9 9 0 11-6.2-8.5" />
    </svg>
  );
}

// Universal "working" indicator: three dots fading in sequence (typing-style).
// Same shape for every agent; colour is set by the host via currentColor.
export function WorkingDots() {
  return (
    <span className="working-dots" aria-hidden>
      <i /><i /><i />
    </span>
  );
}

export function IconCircle() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="#b9b6af" strokeWidth={2} strokeLinecap="round">
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}

export function IconPlan() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 11l3 3L22 4M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
    </svg>
  );
}

export function IconCopy() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}

export function IconLock() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 018 0v3" />
    </svg>
  );
}

// Question mark in a circle — the agent-question (elicitation) card.
export function IconQuestion() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3" />
      <path d="M12 17h.01" />
    </svg>
  );
}

// Arrow entering a door frame — the "log in / sign in" action.
export function IconLogin() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4" />
      <path d="M10 17l5-5-5-5" />
      <path d="M15 12H3" />
    </svg>
  );
}

// ---- Robot empty state ----

export function Robot() {
  return (
    <svg className="robot" viewBox="0 0 24 24" fill="#d97757">
      <rect x="6" y="7" width="12" height="9" rx="2.5" />
      <rect x="9" y="10" width="2" height="2" rx=".5" fill="#fff" />
      <rect x="13" y="10" width="2" height="2" rx=".5" fill="#fff" />
      <rect x="7" y="16" width="2" height="3" rx="1" />
      <rect x="11" y="16" width="2" height="3" rx="1" />
      <rect x="15" y="16" width="2" height="3" rx="1" />
      <rect x="11" y="3.5" width="2" height="3" rx="1" />
    </svg>
  );
}

export function CodexMark() {
  // Glassy blue→indigo "bloom" brand mark with a white terminal `>_`. The cloud
  // is a clip path of overlapping circles; three layers paint through it — a blue
  // body, a soft pink/lavender glow near the top, and a glossy top-edge highlight
  // — for the 3D look of the real Codex glyph. Self-coloured (ignores
  // currentColor) so it reads at every size. useId keeps the gradient/clip ids
  // unique across the several places this renders at once.
  const gid = useId();
  const body = `${gid}-body`, bloom = `${gid}-bloom`, rim = `${gid}-rim`, clip = `${gid}-clip`;
  return (
    <svg className="codex-mark" viewBox="0 0 64 64" fill="none" aria-hidden>
      <defs>
        <linearGradient id={body} x1="16" y1="10" x2="48" y2="56" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#A9B6FF" />
          <stop offset="0.45" stopColor="#5E63F0" />
          <stop offset="1" stopColor="#3A3DDB" />
        </linearGradient>
        <radialGradient id={bloom} cx="0.46" cy="0.30" r="0.55">
          <stop offset="0" stopColor="#F6DCFF" stopOpacity="0.9" />
          <stop offset="0.55" stopColor="#D2C0FF" stopOpacity="0.25" />
          <stop offset="1" stopColor="#D2C0FF" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={rim} x1="32" y1="6" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fff" stopOpacity="0.6" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <clipPath id={clip}>
          <circle cx="32" cy="32" r="15" />
          <circle cx="47" cy="32" r="10" />
          <circle cx="42.6" cy="21.4" r="10" />
          <circle cx="32" cy="17" r="10" />
          <circle cx="21.4" cy="21.4" r="10" />
          <circle cx="17" cy="32" r="10" />
          <circle cx="21.4" cy="42.6" r="10" />
          <circle cx="32" cy="47" r="10" />
          <circle cx="42.6" cy="42.6" r="10" />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clip})`}>
        <rect x="0" y="0" width="64" height="64" fill={`url(#${body})`} />
        <rect x="0" y="0" width="64" height="64" fill={`url(#${bloom})`} />
        <rect x="0" y="2" width="64" height="30" fill={`url(#${rim})`} />
      </g>
      <path d="M24 23 L34 32 L24 41" stroke="#fff" strokeWidth="5.2" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M33 41 H45" stroke="#fff" strokeWidth="5.2" strokeLinecap="round" />
    </svg>
  );
}

export function OpencodeMark() {
  // The opencode favicon (per opencode.ai/brand): a near-black rounded square
  // with a white "O" ring. Scaled to a 64×64 viewBox to match CodexMark and
  // rounded slightly to read as a chip in the agent pill / empty state.
  // Self-coloured (ignores currentColor) — the brand is the dark square.
  return (
    <svg className="opencode-mark" viewBox="0 0 64 64" fill="none" aria-hidden>
      <rect x="0" y="0" width="64" height="64" rx="10" fill="#131010" />
      <path fillRule="evenodd" clipRule="evenodd" fill="#fff"
        d="M48 52H16V12H48V52ZM40 20H24V44H40V20Z" />
      <rect x="24" y="28" width="16" height="16" fill="#5A5858" />
    </svg>
  );
}

// ---- Tool icons ----

const TOOL_PATHS: Record<string, ReactElement> = {
  read: (
    <>
      <path d="M4 5a2 2 0 012-2h8l4 4v12a2 2 0 01-2 2H6a2 2 0 01-2-2z" />
      <path d="M14 3v4h4" />
    </>
  ),
  edit: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z" />
    </>
  ),
  delete: (
    <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
  ),
  move: (
    <path d="M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20" />
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4-4" />
    </>
  ),
  execute: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M7 9l3 3-3 3M13 15h4" />
    </>
  ),
  think: (
    <path d="M9 18h6M10 22h4M12 2a7 7 0 00-4 12.7V17h8v-2.3A7 7 0 0012 2z" />
  ),
  fetch: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a15 15 0 010 18 15 15 0 010-18z" />
    </>
  ),
  other: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v4M12 16h.01" />
    </>
  ),
};

export function toolIcon(kind: string): ReactElement {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      {TOOL_PATHS[kind] ?? TOOL_PATHS.other}
    </svg>
  );
}
