// Form elicitation (`elicitation/create`) helpers: parse an ACP requestedSchema
// into renderable fields, and fold the user's selections back into the reply
// content. This is how claude-agent-acp surfaces the AskUserQuestion tool — one
// single/multi-select field per question, each followed by a free-text "Other"
// companion — and how MCP servers' form elicitations arrive, so the parser also
// copes with plain string/number/boolean/enum properties.

import type { ElicitationField, ElicitationOption } from "../types.ts";

// `_meta` key under which claude-agent-acp forwards an AskUserQuestion option's
// structured description (ACP's EnumOption has no field for it; the flattened
// "label — description" lands in `title` for clients that don't read _meta).
const OPTION_META_KEY = "_claude/askUserQuestionOption";

interface EnumOptionSchema {
  const?: unknown;
  title?: string;
  _meta?: Record<string, unknown>;
}

interface PropertySchema {
  type?: string;
  title?: string;
  description?: string;
  oneOf?: EnumOptionSchema[];
  anyOf?: EnumOptionSchema[];
  enum?: unknown[];
  items?: { anyOf?: EnumOptionSchema[]; oneOf?: EnumOptionSchema[]; enum?: unknown[] };
}

function parseOption(o: EnumOptionSchema): ElicitationOption | null {
  if (!o || o.const === undefined || o.const === null) return null;
  const value = String(o.const);
  const meta = o._meta?.[OPTION_META_KEY] as { description?: string } | undefined;
  if (meta?.description) return { value, label: value, description: meta.description };
  // No structured _meta: recover the description from the flattened title when it
  // follows the "label — description" shape; otherwise the title IS the label
  // (generic MCP enums often pair a machine `const` with a human `title`).
  const title = typeof o.title === "string" ? o.title : "";
  if (title.startsWith(value + " — ")) return { value, label: value, description: title.slice(value.length + 3) };
  return { value, label: title || value };
}

function parseEnumValues(values: unknown[]): ElicitationOption[] {
  return values
    .filter((v) => v !== undefined && v !== null)
    .map((v) => ({ value: String(v), label: String(v) }));
}

function parseOptions(prop: PropertySchema): { multi: boolean; options: ElicitationOption[] } {
  const single = prop.oneOf ?? prop.anyOf;
  if (Array.isArray(single)) {
    return { multi: false, options: single.map(parseOption).filter((o): o is ElicitationOption => o !== null) };
  }
  if (Array.isArray(prop.enum)) return { multi: false, options: parseEnumValues(prop.enum) };
  if (prop.type === "array") {
    const item = prop.items ?? {};
    const opts = item.anyOf ?? item.oneOf;
    if (Array.isArray(opts)) {
      return { multi: true, options: opts.map(parseOption).filter((o): o is ElicitationOption => o !== null) };
    }
    if (Array.isArray(item.enum)) return { multi: true, options: parseEnumValues(item.enum) };
  }
  // A bare boolean renders as a yes/no choice; buildElicitationContent coerces
  // the picked value back to a real boolean via valueType.
  if (prop.type === "boolean") {
    return { multi: false, options: [{ value: "true", label: "Yes" }, { value: "false", label: "No" }] };
  }
  return { multi: false, options: [] };
}

function valueTypeOf(prop: PropertySchema): ElicitationField["valueType"] {
  return prop.type === "number" || prop.type === "integer" || prop.type === "boolean" ? prop.type : "string";
}

// Parse an elicitation requestedSchema into fields, preserving property order
// (the adapter emits each question's select immediately followed by its "Other"
// box, so order is meaningful). Tolerant of junk: a malformed schema simply
// yields no fields and the card still offers Submit/Skip on the message alone.
export function parseElicitationFields(requestedSchema: unknown): ElicitationField[] {
  const schema = requestedSchema as { properties?: Record<string, PropertySchema> } | null | undefined;
  const props = schema?.properties;
  if (!props || typeof props !== "object") return [];
  const fields: ElicitationField[] = [];
  for (const [key, prop] of Object.entries(props)) {
    if (!prop || typeof prop !== "object") continue;
    const { multi, options } = parseOptions(prop);
    fields.push({
      key,
      title: typeof prop.title === "string" && prop.title ? prop.title : undefined,
      description: typeof prop.description === "string" && prop.description ? prop.description : undefined,
      multi,
      valueType: valueTypeOf(prop),
      options,
    });
  }
  return fields;
}

// What the form component collects: option values for selects (string[] when
// multi), free text for open fields. Empty/unset entries are simply omitted
// from the reply — nothing in an elicitation form is required.
export type ElicitationValues = Record<string, string | string[] | undefined>;

function coerce(value: string, valueType: ElicitationField["valueType"]): unknown {
  if (valueType === "boolean") return value === "true";
  if (valueType === "number" || valueType === "integer") {
    const n = Number(value);
    return Number.isNaN(n) ? value : n;
  }
  return value;
}

// Fold the collected values into the `content` object for an "accept" reply,
// coercing each back to its schema type and dropping empty answers.
export function buildElicitationContent(fields: ElicitationField[], values: ElicitationValues): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  for (const f of fields) {
    const v = values[f.key];
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      if (v.length) content[f.key] = v.map((x) => coerce(x, f.valueType));
    } else if (v.trim() !== "") {
      content[f.key] = coerce(f.options.length ? v : v.trim(), f.valueType);
    }
  }
  return content;
}

// One-line recap for the resolved card ("→ …"), mapping picked values back to
// their option labels. Multiple answered fields join with " · ".
export function summarizeElicitationAnswers(fields: ElicitationField[], values: ElicitationValues): string {
  const parts: string[] = [];
  for (const f of fields) {
    const v = values[f.key];
    const picked = Array.isArray(v) ? v : typeof v === "string" && v.trim() !== "" ? [v.trim()] : [];
    if (!picked.length) continue;
    const labels = picked.map((x) => f.options.find((o) => o.value === x)?.label ?? x);
    parts.push(labels.join(", "));
  }
  return parts.join(" · ");
}
