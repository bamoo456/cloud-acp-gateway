// Cmd/Ctrl-click go-to-definition helpers. The analyzer behind this only
// indexes Java (see ACPG_LSP_JAVA), so anything else never issues a request —
// an unresolvable symbol answers slow-and-empty, which is a 2 s hang per click
// the client can simply not pay for.
export interface LineColumn { line: number; column: number } // both 1-based

export function isDefinitionPath(filePath: string): boolean {
  return /\.java$/i.test(filePath);
}

// A character offset inside the rendered code text (UTF-16 units, as
// textContent counts them) as the 1-based line + column the gateway's
// /workspace/definition route takes.
export function offsetToLineColumn(text: string, offset: number): LineColumn {
  const clamped = Math.max(0, Math.min(text.length, offset));
  const upto = text.slice(0, clamped);
  return { line: upto.split("\n").length, column: clamped - upto.lastIndexOf("\n") };
}
