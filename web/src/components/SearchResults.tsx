import type { SearchResponse, SearchResultSession } from "../lib/api.ts";

// The server sends highlight RANGES, never markup, so the snippet stays plain
// text all the way to React and cannot inject anything.
export function highlightParts(snippet: string, offsets: Array<[number, number]>): Array<{ text: string; hit: boolean }> {
  const parts: Array<{ text: string; hit: boolean }> = [];
  let at = 0;
  for (const [start, end] of offsets) {
    if (start < at || end > snippet.length) continue; // ignore overlapping/out-of-range ranges
    if (start > at) parts.push({ text: snippet.slice(at, start), hit: false });
    parts.push({ text: snippet.slice(start, end), hit: true });
    at = end;
  }
  if (at < snippet.length) parts.push({ text: snippet.slice(at), hit: false });
  return parts;
}

export function SearchResults(props: {
  response: SearchResponse | null;
  loading: boolean;
  // True when the user picked an explicit date range: truncation then happened
  // INSIDE their range, so widening it would silently discard what they asked for.
  rangeExplicit: boolean;
  onOpen: (r: SearchResultSession, index: number) => void;
  onSearchAll: () => void;
  onSearchOlder: () => void;
}) {
  const { response, loading, rangeExplicit } = props;
  if (loading && !response) return <div className="panel-empty">Searching…</div>;
  if (!response) return null;
  if (response.results.length === 0) return <div className="panel-empty">No messages match.</div>;

  return (
    <div className="search-results">
      <div className="listhead"><span>訊息內容 · 全部資料夾</span></div>
      {response.results.map((r) => (
        <button key={r.sessionId} className="search-hit" onClick={() => props.onOpen(r, r.hits[0]?.index ?? 0)}>
          <div className="search-hit-title">{r.title || r.sessionId}</div>
          <div className="search-hit-meta">
            {r.cwd.split("/").filter(Boolean).pop()} · {r.agentName}
            {r.hitCount > r.hits.length ? ` · ${r.hitCount} matches` : ""}
          </div>
          <div className="search-hit-snippet">
            {highlightParts(r.hits[0]?.snippet ?? "", r.hits[0]?.offsets ?? []).map((p, i) =>
              p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>)}
          </div>
        </button>
      ))}
      {response.skipped.length > 0 && (
        <div className="panel-note">Not searchable: {response.skipped.join(", ")}</div>
      )}
      {response.truncated && (
        <button className="search-more" onClick={rangeExplicit ? props.onSearchOlder : props.onSearchAll}>
          {rangeExplicit ? "繼續搜更早" : "搜尋全部"}
        </button>
      )}
    </div>
  );
}
