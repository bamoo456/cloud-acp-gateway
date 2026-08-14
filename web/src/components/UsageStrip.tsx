import { useEffect, useState } from "react";
import { useStore } from "../store/store.ts";
import { formatUntil } from "../lib/format.ts";

// The rate-limit windows worth a segment, left to right. Each carries its own
// short label rather than relying on position, because the phone layout drops
// the countdowns — and four bare percentages say nothing about which quota is
// which. `overage` is deliberately absent: it reports spend against a credit
// balance, not a window, and reads as one more quota bar when it isn't one.
const WINDOWS: Array<{ type: string; label: string; title: string }> = [
  { type: "five_hour", label: "5h", title: "Session limit" },
  { type: "seven_day", label: "wk", title: "Weekly limit" },
  { type: "seven_day_opus", label: "Opus", title: "Opus weekly limit" },
  { type: "seven_day_sonnet", label: "Sonnet", title: "Sonnet weekly limit" },
];

// A 0..1 utilization as whole percent. Floored, so a bar never claims a percent
// that hasn't been spent — but only after the float dust is trimmed, since a
// bare Math.floor(0.57 * 100) is 56.
function percent(utilization: number): number {
  return Math.min(100, Math.floor(Number((utilization * 100).toFixed(4))));
}

// Half the window gone is worth noticing, four fifths is worth acting on. This
// is the one place amber and red mean "the number itself is getting bad" rather
// than "needs you" / "failed" (§1.1) — a quota is the one fact on screen that
// has a fuel gauge's semantics, and it says so with a gauge, not a badge.
const WARN_AT = 50, ERR_AT = 80;

// Blocks rather than one continuous fill, the shape a terminal statusline uses:
// at this size a quarter-full block is legible where three pixels of a 38px bar
// are not. Ceil, so any spend at all lights the first block.
const BLOCKS = 4;

// label · gauge · percent · countdown, in that order — the label leads so the
// row parses left to right, and the countdown trails as one unspaced token
// ("2h12m"), which is why it can sit next to the window's own name without the
// two reading as one figure.
function Segment({ pct, label, note, title }: { pct: number; label?: string; note?: string; title: string }) {
  const tone = pct >= ERR_AT ? "err" : pct >= WARN_AT ? "warn" : "";
  const lit = Math.min(BLOCKS, Math.ceil((pct / 100) * BLOCKS));
  return (
    <span className="u-seg" title={title}>
      {label && <span className="lb">{label}</span>}
      <span className={"u-bar " + tone} aria-hidden>
        {Array.from({ length: BLOCKS }, (_, i) => <i key={i} className={i < lit ? "on" : ""} />)}
      </span>
      <b className={tone}>{pct}%</b>
      {note && <span className="note">{note}</span>}
    </span>
  );
}

// Right-hand end of the bottom status strip: how full the active conversation's
// context window is, plus this account's rate-limit windows. Renders nothing
// until an agent has actually reported usage — both halves arrive on
// `usage_update`, which no agent sends before a turn has produced tokens.
export function UsageStrip() {
  const sess = useStore((s) => (s.activeId ? s.sessions[s.activeId] : null));
  const rateLimits = useStore((s) => s.rateLimits);
  // The countdowns are the only thing here that goes stale without a store
  // update, so re-render once a minute rather than leaving "1h 32m" frozen at
  // whatever it read when the last frame landed.
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, []);

  const segments = [];
  if (sess?.contextSize) {
    const used = sess.contextUsed ?? 0;
    // Clamped: the adapter really does report `used` past `size` for a frame or
    // two while a session moves onto a bigger window (observed 202610/200000,
    // then the same tokens against 1000000), and a gauge reading 101% looks
    // broken rather than full.
    segments.push(
      <Segment key="context" pct={Math.min(100, Math.round((used / sess.contextSize) * 100))} label="ctx"
        title={`${used.toLocaleString()} / ${sess.contextSize.toLocaleString()} tokens in context`} />,
    );
  }
  for (const { type, label, title } of WINDOWS) {
    const rl = rateLimits[type];
    // The adapter only fills `utilization` on some events; a window without one
    // is unknown, not empty, so it gets no bar rather than a 0% one.
    if (typeof rl?.utilization !== "number") continue;
    const until = rl.resetsAt ? formatUntil(rl.resetsAt) : "";
    segments.push(
      <Segment key={type} label={label} note={until} pct={percent(rl.utilization)}
        title={until ? `${title} · resets in ${until}` : title} />,
    );
  }
  // Model-scoped weekly caps, which arrive named rather than under a known key
  // (the endpoint moved them out of the flat seven_day_* fields). Sorted so the
  // order doesn't shuffle between polls.
  for (const [key, rl] of Object.entries(rateLimits).sort(([a], [b]) => a.localeCompare(b))) {
    if (!rl.label || WINDOWS.some((w) => w.type === key)) continue;
    if (typeof rl.utilization !== "number") continue;
    const until = rl.resetsAt ? formatUntil(rl.resetsAt) : "";
    segments.push(
      <Segment key={key} label={rl.label} note={until} pct={percent(rl.utilization)}
        title={until ? `${rl.label} weekly limit · resets in ${until}` : `${rl.label} weekly limit`} />,
    );
  }
  if (!segments.length) return null;

  // The "·" between segments is a CSS ::before on every segment but the first,
  // so nothing here has to carry a separator it doesn't own.
  return <span className="usage-strip">{segments}</span>;
}
