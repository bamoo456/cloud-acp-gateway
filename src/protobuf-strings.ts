/**
 * Pull UTF-8 strings out of a protobuf message at a known field path, without
 * the schema.
 *
 * Antigravity's ACP server stores each conversation as protobuf blobs in a
 * SQLite table, against an unpublished google3 schema. The wire format is
 * self-describing enough to reach a field by number — every field states its
 * wire type, so a walker can skip what it cannot interpret and still land on
 * the one string we want. That is the whole trick here: no message types, no
 * reflection, just "give me the strings at 19.2".
 *
 * The failure mode is the point. If Antigravity renumbers a field, the walk
 * finds nothing and the caller shows a conversation with no title — never a
 * title made of the wrong bytes.
 */

// Reads a base-128 varint. Accumulates with arithmetic rather than `|`, which
// truncates to 32 bits in JS and would silently mangle a long length prefix
// into a short one — the walk would then resync mid-field and emit garbage.
function readVarint(b: Uint8Array, at: { i: number }): number | null {
  let value = 0;
  let shift = 0;
  while (at.i < b.length) {
    const byte = b[at.i++];
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if ((byte & 0x80) === 0) return value;
    if (shift > 63) return null; // malformed: longer than any valid varint
  }
  return null; // ran off the end mid-varint
}

/**
 * Every UTF-8 string at `fieldPath` (a list of field numbers, outermost first),
 * in encounter order. A path element that isn't a length-delimited field, bytes
 * that aren't valid UTF-8, and a truncated buffer all yield nothing rather than
 * throwing: this reads third-party blobs, so unrecognisable input is expected
 * and has to degrade to "no strings here".
 */
export function protobufStringsAt(buf: Uint8Array, fieldPath: readonly number[]): string[] {
  const out: string[] = [];
  if (fieldPath.length === 0) return out;
  const utf8 = new TextDecoder("utf-8", { fatal: true });

  const walk = (b: Uint8Array, depth: number): void => {
    const at = { i: 0 };
    while (at.i < b.length) {
      const key = readVarint(b, at);
      if (key === null) return;
      const field = Math.floor(key / 8);
      switch (key % 8) {
        case 0: // varint
          if (readVarint(b, at) === null) return;
          break;
        case 1: // 64-bit
          at.i += 8;
          break;
        case 5: // 32-bit
          at.i += 4;
          break;
        case 2: { // length-delimited: bytes, string, or a nested message
          const len = readVarint(b, at);
          if (len === null || at.i + len > b.length) return;
          const chunk = b.subarray(at.i, at.i + len);
          at.i += len;
          if (field !== fieldPath[depth]) break;
          if (depth === fieldPath.length - 1) {
            try { out.push(utf8.decode(chunk)); } catch { /* not a UTF-8 string */ }
          } else {
            walk(chunk, depth + 1);
          }
          break;
        }
        default: // groups (3/4) — proto3 never emits them; anything else is noise
          return;
      }
    }
  };

  walk(buf, 0);
  return out;
}
