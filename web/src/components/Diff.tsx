type Row = { t: "ctx" | "add" | "del"; text: string };
function diffLines(a: string[], b: string[]): Row[] {
  if (a.length * b.length > 40000) {
    return [...a.map((l) => ({ t: "del" as const, text: l })), ...b.map((l) => ({ t: "add" as const, text: l }))];
  }
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const res: Row[] = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { res.push({ t: "ctx", text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { res.push({ t: "del", text: a[i] }); i++; }
    else { res.push({ t: "add", text: b[j] }); j++; }
  }
  while (i < n) res.push({ t: "del", text: a[i++] });
  while (j < m) res.push({ t: "add", text: b[j++] });
  return res;
}
// `renderPath` lets a caller turn the header into a control (ToolCall makes it
// open the file preview panel) without this component knowing about the store.
// Default: the plain label it has always been.
export function Diff({ path, oldText, newText, renderPath }: {
  path?: string; oldText?: string; newText?: string;
  renderPath?: (path: string) => React.ReactNode;
}) {
  const rows = diffLines((oldText || "").split("\n"), (newText || "").split("\n"));
  return (
    <div className="diff">
      {path && renderPath ? renderPath(path) : <div className="path">{path || "diff"}</div>}
      {rows.map((r, k) => <span key={k} className={"ln " + r.t}>{r.text}</span>)}
    </div>
  );
}
