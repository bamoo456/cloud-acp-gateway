import { test } from "node:test";
import assert from "node:assert/strict";
import { protobufStringsAt } from "./protobuf-strings.ts";

// Minimal protobuf writers — enough to build the shapes the walk has to survive.
const varint = (n: number): number[] => {
  const out: number[] = [];
  let v = n;
  while (v > 0x7f) { out.push((v & 0x7f) | 0x80); v = Math.floor(v / 128); }
  out.push(v);
  return out;
};
const lenDelim = (field: number, body: number[] | Uint8Array): number[] => [
  ...varint(field * 8 + 2), ...varint(body.length), ...body,
];
const str = (field: number, s: string) => lenDelim(field, [...new TextEncoder().encode(s)]);
const int = (field: number, n: number) => [...varint(field * 8), ...varint(n)];
const buf = (...parts: number[][]) => new Uint8Array(parts.flat());

test("reads a nested string by field path", () => {
  const msg = buf(int(1, 14), lenDelim(19, str(2, "Reply with exactly: AGY_OK_42")));
  assert.deepEqual(protobufStringsAt(msg, [19, 2]), ["Reply with exactly: AGY_OK_42"]);
});

test("skips varint, 32-bit and 64-bit fields to reach a later one", () => {
  const msg = buf(
    int(3, 300),
    [4 * 8 + 5, 1, 2, 3, 4],
    [7 * 8 + 1, 1, 2, 3, 4, 5, 6, 7, 8],
    lenDelim(20, str(1, "answer")),
  );
  assert.deepEqual(protobufStringsAt(msg, [20, 1]), ["answer"]);
});

test("returns every match, in encounter order", () => {
  const msg = buf(lenDelim(20, str(1, "first")), lenDelim(20, str(1, "second")));
  assert.deepEqual(protobufStringsAt(msg, [20, 1]), ["first", "second"]);
});

test("a path that does not match yields nothing rather than a wrong string", () => {
  const msg = buf(lenDelim(19, str(2, "user text")));
  assert.deepEqual(protobufStringsAt(msg, [20, 1]), []);
  assert.deepEqual(protobufStringsAt(msg, [19, 3]), []);
});

test("non-UTF-8 bytes at the target path are dropped", () => {
  const msg = buf(lenDelim(19, lenDelim(2, [0xff, 0xfe, 0xff])));
  assert.deepEqual(protobufStringsAt(msg, [19, 2]), []);
});

test("a truncated buffer stops the walk instead of throwing", () => {
  const whole = buf(lenDelim(19, str(2, "complete")));
  assert.deepEqual(protobufStringsAt(whole.subarray(0, whole.length - 4), [19, 2]), []);
  assert.deepEqual(protobufStringsAt(new Uint8Array([0x8a]), [19, 2]), []);
});

test("a length prefix past 32 bits does not wrap into a short read", () => {
  // 0x1_0000_0005 as a length: `|`-based accumulation truncates this to 5 and
  // would then resync mid-message and emit a bogus string.
  const msg = new Uint8Array([19 * 8 + 2, ...varint(2 ** 32 + 5), ...new TextEncoder().encode("xxxxx")]);
  assert.deepEqual(protobufStringsAt(msg, [19, 2]), []);
});

test("an empty path matches nothing", () => {
  assert.deepEqual(protobufStringsAt(buf(str(1, "x")), []), []);
});
