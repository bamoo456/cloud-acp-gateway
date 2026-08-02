import type { SearchOptions } from "../lib/api.ts";
import { IconChevronRight } from "../lib/icons.tsx";

export type FilterState = {
  window: "14d" | "30d" | "all" | "custom";
  since: string;   // yyyy-mm-dd from <input type="date">, "" when unset
  until: string;
  agent: string;   // "" = every configured agent
  folderOnly: boolean;
  mineOnly: boolean;
};

// Deliberately NOT persisted — not to localStorage, and not to the cross-device
// `meta` KV that holds text_size/screen_lock. A sticky custom range that silently
// applies to the next search is worse than re-picking it.
export const DEFAULT_FILTERS: FilterState = {
  window: "14d", since: "", until: "", agent: "", folderOnly: false, mineOnly: false,
};

const DAY_MS = 86400000;
// <input type="date"> yields yyyy-mm-dd, which Date.parse reads as UTC midnight —
// but the user picked a day on THEIR calendar, so both bounds are built locally.
// `until` runs to the END of its day because the server's upper bound is inclusive
// (`recencyMs > untilMs` skips, src/gateway.ts:1279): bounding at the start of the
// chosen day would return nothing from that day, which reads as a broken filter.
const dayBound = (v: string, edge: "start" | "end"): string | undefined => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return undefined;
  const d = edge === "start"
    ? new Date(+m[1], +m[2] - 1, +m[3], 0, 0, 0, 0)
    : new Date(+m[1], +m[2] - 1, +m[3], 23, 59, 59, 999);
  return Number.isFinite(d.getTime()) ? d.toISOString() : undefined;
};

export function filtersToOptions(f: FilterState, cwd: string, nowMs: number): SearchOptions {
  const o: SearchOptions = {};
  // "14d" is the server's own default, so it sends nothing — one source of truth.
  if (f.window === "30d") o.since = new Date(nowMs - 30 * DAY_MS).toISOString();
  if (f.window === "all") o.all = true;
  if (f.window === "custom") {
    const since = dayBound(f.since, "start");
    const until = dayBound(f.until, "end");
    if (since) o.since = since; else o.all = true; // an open-ended custom start means "everything"
    if (until) o.until = until;
  }
  if (f.agent) o.agent = f.agent;
  if (f.folderOnly && cwd) o.cwd = cwd;
  if (f.mineOnly) o.role = "user";
  return o;
}

export function SearchFilters(props: { value: FilterState; agents: string[]; onChange: (next: FilterState) => void }) {
  const { value: v, onChange } = props;
  const set = (patch: Partial<FilterState>) => onChange({ ...v, ...patch });
  return (
    <details className="search-filters">
      <summary><span className="chev"><IconChevronRight /></span>進階</summary>
      <div className="search-filter-row">
        {(["14d", "30d", "all", "custom"] as const).map((w) => (
          <button key={w} className={"chip" + (v.window === w ? " active" : "")} onClick={() => set({ window: w })}>
            {w === "14d" ? "最近 14 天" : w === "30d" ? "最近 30 天" : w === "all" ? "全部" : "自訂"}
          </button>
        ))}
      </div>
      {v.window === "custom" && (
        <div className="search-filter-row">
          <input type="date" value={v.since} onChange={(e) => set({ since: e.target.value })} />
          <input type="date" value={v.until} onChange={(e) => set({ until: e.target.value })} />
        </div>
      )}
      <div className="search-filter-row">
        <select value={v.agent} onChange={(e) => set({ agent: e.target.value })}>
          <option value="">全部 agent</option>
          {props.agents.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </div>
      <div className="search-filter-row">
        <label><input type="checkbox" checked={v.folderOnly} onChange={(e) => set({ folderOnly: e.target.checked })} /> 只搜這個資料夾</label>
        <label><input type="checkbox" checked={v.mineOnly} onChange={(e) => set({ mineOnly: e.target.checked })} /> 只搜我的訊息</label>
      </div>
    </details>
  );
}
