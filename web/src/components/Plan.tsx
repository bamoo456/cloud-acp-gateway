import type { PlanEntry } from "../types.ts";
import { IconPlan } from "../lib/icons.tsx";

// The `box` / `box spin` classes are sized by `.plan li .box` in styles.css, and
// the svg must stay a direct child of the <li> — that is what the selector
// targets. The strokes are currentColor so each row's own state colour reaches
// them: done is muted, running is ink, neither is green or amber (§1.1).
function PlanBox({ status }: { status?: string }) {
  if (status === "completed") {
    return (
      <svg className="box" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 6L9 17l-5-5" />
      </svg>
    );
  }
  if (status === "in_progress") {
    return (
      <svg className="box spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round">
        <path d="M21 12a9 9 0 11-6.2-8.5" />
      </svg>
    );
  }
  return (
    <svg className="box" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" opacity={0.45}>
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}

// `heading` is off in the file panel, where the section it sits in is already
// labelled — two headings stacked would just be the word twice.
export function Plan({ entries, heading = true }: { entries: PlanEntry[]; heading?: boolean }) {
  return (
    <div className="plan">
      {heading && <div className="ph"><IconPlan />Plan</div>}
      <ul>
        {entries.map((e, k) => (
          <li key={k} className={e.status || ""}>
            <PlanBox status={e.status} />
            <span className="txt">{e.content || ""}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
