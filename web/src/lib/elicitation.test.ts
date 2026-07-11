import { describe, test, expect } from "vitest";
import { parseElicitationFields, buildElicitationContent, summarizeElicitationAnswers } from "./elicitation.ts";

// The wire shape claude-agent-acp emits for AskUserQuestion: one select per
// question (titled oneOf/anyOf enum, structured description under _meta) plus a
// free-text "Other" companion field.
const askUserQuestionSchema = {
  type: "object",
  properties: {
    question_0: {
      type: "string",
      title: "Library",
      description: "Which library should we use?",
      oneOf: [
        {
          const: "React Query",
          title: "React Query — Server-state focused",
          _meta: { "_claude/askUserQuestionOption": { description: "Server-state focused" } },
        },
        { const: "SWR", title: "SWR — Lightweight" },
      ],
    },
    question_0_custom: {
      type: "string",
      title: "Other",
      description: "Type your own answer instead of choosing an option above (optional).",
    },
    question_1: {
      type: "array",
      title: "Features",
      description: "Which features do you want?",
      items: { anyOf: [{ const: "Auth", title: "Auth" }, { const: "Search", title: "Search" }] },
    },
    question_1_custom: { type: "string", title: "Other" },
  },
};

describe("parseElicitationFields", () => {
  test("parses the AskUserQuestion shape: selects, multi-selects, and Other boxes in order", () => {
    const fields = parseElicitationFields(askUserQuestionSchema);
    expect(fields.map((f) => f.key)).toEqual(["question_0", "question_0_custom", "question_1", "question_1_custom"]);

    const [q0, q0c, q1] = fields;
    expect(q0).toMatchObject({ title: "Library", description: "Which library should we use?", multi: false });
    // Structured _meta wins; without it, the description is recovered from the
    // flattened "label — description" title; the label is always the clean const.
    expect(q0.options).toEqual([
      { value: "React Query", label: "React Query", description: "Server-state focused" },
      { value: "SWR", label: "SWR", description: "Lightweight" },
    ]);
    expect(q0c).toMatchObject({ title: "Other", multi: false, options: [] });
    expect(q1).toMatchObject({ title: "Features", multi: true });
    expect(q1.options.map((o) => o.value)).toEqual(["Auth", "Search"]);
  });

  test("handles generic MCP shapes: plain enums, booleans, and numbers", () => {
    const fields = parseElicitationFields({
      type: "object",
      properties: {
        env: { type: "string", enum: ["dev", "prod"] },
        confirm: { type: "boolean", title: "Proceed?" },
        count: { type: "number" },
      },
    });
    expect(fields[0].options.map((o) => o.value)).toEqual(["dev", "prod"]);
    expect(fields[1].options).toEqual([{ value: "true", label: "Yes" }, { value: "false", label: "No" }]);
    expect(fields[2]).toMatchObject({ valueType: "number", options: [] });
  });

  test("a titled enum option without a dash keeps the title as the label", () => {
    const fields = parseElicitationFields({
      type: "object",
      properties: { mode: { type: "string", oneOf: [{ const: "a", title: "Option A" }] } },
    });
    expect(fields[0].options).toEqual([{ value: "a", label: "Option A" }]);
  });

  test("tolerates junk schemas", () => {
    expect(parseElicitationFields(undefined)).toEqual([]);
    expect(parseElicitationFields({})).toEqual([]);
    expect(parseElicitationFields({ properties: "nope" })).toEqual([]);
  });
});

describe("buildElicitationContent", () => {
  const fields = parseElicitationFields(askUserQuestionSchema);

  test("keeps picked values, coerces types, and drops empty answers", () => {
    const content = buildElicitationContent(fields, {
      question_0: "SWR",
      question_0_custom: "   ",          // whitespace-only → omitted
      question_1: ["Auth", "Search"],
    });
    expect(content).toEqual({ question_0: "SWR", question_1: ["Auth", "Search"] });
  });

  test("trims free text and coerces boolean/number selections", () => {
    const f = parseElicitationFields({
      type: "object",
      properties: { confirm: { type: "boolean" }, count: { type: "number" }, note: { type: "string" } },
    });
    expect(buildElicitationContent(f, { confirm: "true", count: "3", note: "  hi  " }))
      .toEqual({ confirm: true, count: 3, note: "hi" });
  });

  test("an empty form yields an empty content object (Submit with nothing picked)", () => {
    expect(buildElicitationContent(fields, {})).toEqual({});
  });
});

describe("summarizeElicitationAnswers", () => {
  const fields = parseElicitationFields(askUserQuestionSchema);

  test("recaps picked labels and typed answers", () => {
    expect(summarizeElicitationAnswers(fields, { question_0: "SWR", question_1: ["Auth", "Search"] }))
      .toBe("SWR · Auth, Search");
    expect(summarizeElicitationAnswers(fields, { question_0_custom: "use axios" })).toBe("use axios");
    expect(summarizeElicitationAnswers(fields, {})).toBe("");
  });
});
