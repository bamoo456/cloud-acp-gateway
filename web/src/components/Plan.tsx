import type { PlanEntry } from "../types.ts";
import { IconPlan } from "../lib/icons.tsx";

// The plan checkboxes are inlined verbatim from public/console.html:957-961 so the
// stroke colors/weights and the `box`/`box spin` classes (sized by .plan li .box in
// styles.css) match the legacy console exactly — the box svg is a direct child of
// the <li>, not wrapped, which is what the CSS selector targets.
function PlanBox({ status }: { status?: string }) {
  if (status === "completed") {
    return (
      <svg className="box" viewBox="0 0 24 24" fill="none" stroke="#3a9b5c" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 6L9 17l-5-5" />
      </svg>
    );
  }
  if (status === "in_progress") {
    return (
      <svg className="box spin" viewBox="0 0 24 24" fill="none" stroke="#c98a23" strokeWidth={2.4} strokeLinecap="round">
        <path d="M21 12a9 9 0 11-6.2-8.5" />
      </svg>
    );
  }
  return (
    <svg className="box" viewBox="0 0 24 24" fill="none" stroke="#b9b6af" strokeWidth={2} strokeLinecap="round">
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}

export function Plan({ entries }: { entries: PlanEntry[] }) {
  return (
    <div className="plan">
      <div className="ph"><IconPlan />Plan</div>
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
