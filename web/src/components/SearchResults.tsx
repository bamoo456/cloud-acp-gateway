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

// The server centres a snippet on its match (SNIPPET_RADIUS = 120 chars either
// side), which reads well in a wide column but not in a ~270px sidebar: 120
// chars of lead is about three lines, so the row clamp that keeps a result from
// eating a third of the viewport (styles.css) would cut exactly where the
// highlight is. Trim the lead — never the trailing context — so the match lands
// in the first line or two, shifting the ranges with it. CSS alone cannot do
// this: a clamp drops the END of the text and the match sits in the middle.
// 32 chars keeps the match on the second line even for CJK, which fits roughly
// half as many characters per line as English.
const MAX_LEAD_CHARS = 32;
export function focusSnippet(snippet: string, offsets: Array<[number, number]>) {
  // The server emits offsets sorted, so the first range is the earliest match.
  const first = offsets[0]?.[0] ?? 0;
  if (first <= MAX_LEAD_CHARS) return { snippet, offsets };
  const shift = first - MAX_LEAD_CHARS - 1; // -1: the "…" replaces one cut char
  return {
    snippet: "…" + snippet.slice(shift + 1),
    offsets: offsets.map(([s, e]) => [s - shift, e - shift] as [number, number]),
  };
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
  const empty = response.results.length === 0;
  // The recency window is a scan budget and an ordering, not a corpus boundary —
  // so finding nothing inside the default window must never read as "it isn't
  // there". Offer the same widening the truncation escape offers, but only when
  // truncation did NOT already render one (they are the same action), and only
  // while the range is still ours to widen: a range the user picked is theirs.
  const offerWiden = empty && !response.truncated && !rangeExplicit;

  return (
    <div className="search-results">
      {!empty && <div className="listhead"><span>訊息內容 · 全部資料夾</span></div>}
      {response.results.map((r) => {
        const focus = focusSnippet(r.hits[0]?.snippet ?? "", r.hits[0]?.offsets ?? []);
        return (
          <button key={r.sessionId} className="search-hit" onClick={() => props.onOpen(r, r.hits[0]?.index ?? 0)}>
            <div className="search-hit-title">{r.title || r.sessionId}</div>
            <div className="search-hit-meta">
              {r.cwd.split("/").filter(Boolean).pop()} · {r.agentName}
              {r.hitCount > r.hits.length ? ` · ${r.hitCount} matches` : ""}
            </div>
            <div className="search-hit-snippet">
              {highlightParts(focus.snippet, focus.offsets).map((p, i) =>
                p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>)}
            </div>
          </button>
        );
      })}
      {response.skipped.length > 0 && (
        <div className="panel-note">Not searchable: {response.skipped.join(", ")}</div>
      )}
      {response.truncated && (
        <button className="search-more" onClick={rangeExplicit ? props.onSearchOlder : props.onSearchAll}>
          {rangeExplicit ? "繼續搜更早" : "搜尋全部"}
        </button>
      )}
      {/* Last, deliberately: this used to be an early return, which swallowed
          the skipped notice and both escapes above — exactly the cases they
          exist for. Rendering it after them makes that shadowing impossible. */}
      {empty && (
        <div className="panel-empty">
          No messages match.{offerWiden ? " 目前只搜尋了最近的對話。" : ""}
        </div>
      )}
      {offerWiden && (
        <button className="search-more" onClick={props.onSearchAll}>搜尋全部</button>
      )}
    </div>
  );
}
