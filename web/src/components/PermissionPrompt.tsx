import { useState } from "react";
import type { ThreadItem } from "../types.ts";
import { answerPermission } from "../store/store.ts";
type Perm = Extract<ThreadItem, { kind: "permission" }>;
export function PermissionPrompt({ item }: { item: Perm }) {
  const [chosen, setChosen] = useState<string | null>(null);
  const resolved = item.resolved || chosen != null;
  // No header strip and no lock glyph: amber is reserved for "needs you"
  // (§1.1), so a 2px amber edge and one line of prose say the whole thing.
  return (
    <div className={"perm" + (resolved ? " resolved" : "")}>
      <div className="q">{item.title}</div>
      <div className="sub">needs you</div>
      <div className="opts">
        {item.options.map((o) => (
          <button key={o.optionId} className={/allow/.test(o.kind || "") ? "allow" : ""}
            onClick={() => { answerPermission(item.reqId, o.optionId); setChosen(o.name || o.optionId); }}>
            {o.name || o.optionId}
          </button>
        ))}
      </div>
      <div className="chosen">{chosen ? "→ " + chosen : ""}</div>
    </div>
  );
}
