import { useState } from "react";
import type { ElicitationField, ThreadItem } from "../types.ts";
import { answerElicitation } from "../store/store.ts";
import { buildElicitationContent, summarizeElicitationAnswers, type ElicitationValues } from "../lib/elicitation.ts";
import { IconQuestion } from "../lib/icons.tsx";

type Elic = Extract<ThreadItem, { kind: "elicitation" }>;

// The agent's question card (AskUserQuestion / MCP form elicitation): the
// question text with tappable options — single choice, multi-select, or a
// free-text answer — plus Submit/Skip. Nothing is required: Submit sends
// whatever is picked (possibly nothing), Skip declines the whole form (the
// agent is told the user skipped; the turn continues).
export function ElicitationPrompt({ item }: { item: Elic }) {
  const [values, setValues] = useState<ElicitationValues>({});
  const [answered, setAnswered] = useState<string | null>(null);
  const resolved = item.resolved || answered != null;
  const recap = item.chosen ?? answered;

  const setText = (key: string, v: string) => setValues((cur) => ({ ...cur, [key]: v }));
  const pickSingle = (key: string, v: string) =>
    setValues((cur) => ({ ...cur, [key]: cur[key] === v ? undefined : v })); // tap again to clear
  const toggleMulti = (key: string, v: string) =>
    setValues((cur) => {
      const list = Array.isArray(cur[key]) ? (cur[key] as string[]) : [];
      return { ...cur, [key]: list.includes(v) ? list.filter((x) => x !== v) : [...list, v] };
    });

  const submit = () => {
    const content = buildElicitationContent(item.fields, values);
    const summary = summarizeElicitationAnswers(item.fields, values) || "answered";
    answerElicitation(item.reqId, { action: "accept", content }, summary);
    setAnswered(summary);
  };
  const skip = () => {
    answerElicitation(item.reqId, { action: "decline" }, "skipped");
    setAnswered("skipped");
  };

  return (
    <div className={"perm elicit" + (resolved ? " resolved" : "")}>
      <div className="ph"><IconQuestion /><span>The agent has a question</span></div>
      <div className="sub">{item.message}</div>
      {item.fields.map((f) => (
        <Field key={f.key} field={f} value={values[f.key]}
          onPick={f.multi ? toggleMulti : pickSingle} onText={setText} />
      ))}
      <div className="opts actions">
        <button className="allow" onClick={submit}>Submit</button>
        <button onClick={skip}>Skip</button>
      </div>
      <div className="chosen">{recap ? "→ " + recap : ""}</div>
    </div>
  );
}

function Field({ field, value, onPick, onText }: {
  field: ElicitationField;
  value: string | string[] | undefined;
  onPick: (key: string, v: string) => void;
  onText: (key: string, v: string) => void;
}) {
  if (!field.options.length) {
    // Free-text field (e.g. each question's "Other" box). The description doubles
    // as the placeholder so the input stays compact.
    return (
      <div className="field">
        {field.title && <div className="ftitle">{field.title}</div>}
        <input type="text" className="ftext" value={typeof value === "string" ? value : ""}
          placeholder={field.description || "Type your answer (optional)"}
          onChange={(e) => onText(field.key, e.target.value)} />
      </div>
    );
  }
  const picked = (v: string) => (Array.isArray(value) ? value.includes(v) : value === v);
  return (
    <div className="field">
      {field.title && <div className="ftitle">{field.title}</div>}
      {field.description && <div className="fq">{field.description}</div>}
      <div className="opts">
        {field.options.map((o) => (
          <button key={o.value} className={"choice" + (picked(o.value) ? " selected" : "")}
            onClick={() => onPick(field.key, o.value)}>
            <span className="lbl">{o.label}</span>
            {o.description && <span className="desc">{o.description}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
