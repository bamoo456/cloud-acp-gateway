// Pure search primitives: no filesystem, no gateway state. Everything here is
// deterministic on its inputs so the I/O stages can be tested separately.

export const MIN_QUERY_LEN = 2;

export type ParsedQuery = {
  terms: string[];
  // The term stage B scans raw file bytes for, or null when no term is usable
  // as a probe (see probeFor). A null probe means "scan nothing away".
  probe: string | null;
};

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Transcripts are JSONL, so a term containing a character JSON escapes (`"`,
// `\`, control chars) does not appear literally in the file bytes. Probing on
// one would drop sessions that really do match, so such terms are never chosen.
function probeable(term: string): boolean {
  if (term.includes('"') || term.includes("\\")) return false;
  for (const ch of term) if (ch.charCodeAt(0) < 32) return false;
  return true;
}

function probeFor(terms: string[]): string | null {
  let best: string | null = null;
  for (const t of terms) {
    if (!probeable(t)) continue;
    if (!best || t.length > best.length) best = t;
  }
  return best;
}

export function parseQuery(raw: string): ParsedQuery | null {
  const trimmed = raw.trim();
  if (trimmed.length < MIN_QUERY_LEN) return null;
  const terms = trimmed.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  if (terms.length === 0) return null;
  return { terms, probe: probeFor(terms) };
}
