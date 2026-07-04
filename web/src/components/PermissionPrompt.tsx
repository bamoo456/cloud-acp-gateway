import { useState } from "react";
import type { ThreadItem } from "../types.ts";
import { answerPermission } from "../store/store.ts";
import { IconLock } from "../lib/icons.tsx";
type Perm = Extract<ThreadItem, { kind: "permission" }>;
export function PermissionPrompt({ item }: { item: Perm }) {
  const [chosen, setChosen] = useState<string | null>(null);
  const resolved = item.resolved || chosen != null;
  return (
    <div className={"perm" + (resolved ? " resolved" : "")}>
      <div className="ph"><IconLock /><span>Permission requested</span></div>
      <div className="sub">{item.title}</div>
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
