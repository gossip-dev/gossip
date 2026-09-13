import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CANONICAL_LIMITS,
  canonicalDigest,
  canonicalJson,
  parseCanonicalJson,
} from "../src/canonical.js";
import { ProtocolError } from "../src/protocol-errors.js";

test("canonical JSON sorts integer-looking members lexicographically", () => {
  assert.equal(
    canonicalJson({ "2": 2, a: true, "10": 10 }),
    '{"10":10,"2":2,"a":true}',
  );
});

test("content digests bind the protocol domain and preserve Unicode distinctions", () => {
  const request = canonicalDigest("request", {});
  // Independent Python hashlib calculation over the literal bytes in ADR 0003.
  assert.equal(
    request,
    "sha256:a5594381ae8abd7dfacdbdf6998b3e5b6161ff1b68a4446892f00951579f90fc",
  );
  assert.notEqual(request, canonicalDigest("evidence", {}));
  assert.notEqual(request, canonicalDigest("receipt", {}));
  assert.notEqual(request, canonicalDigest("identity", {}));
  assert.equal(
    canonicalDigest("request", { a: 1, b: 2 }),
    canonicalDigest("request", { b: 2, a: 1 }),
  );
  assert.notEqual(
    canonicalDigest("evidence", "é"),
    canonicalDigest("evidence", "e\u0301"),
  );
  assert.throws(
    () => canonicalDigest("request\nevidence" as "request", {}),
    ProtocolError,
  );
});

test("canonical decoding rejects ambiguous JSON and invalid UTF-8", () => {
  assert.deepEqual(
    parseCanonicalJson(new TextEncoder().encode('{"a":1,"b":2}')),
    { a: 1, b: 2 },
  );
  const invalid = [
    '{"a":1,"a":2}',
    '{"b":2,"a":1}',
    ' {"a":1}',
    "-0",
    "1e0",
    '"\\u0061"',
    '"\\ud800"',
    "\ufeff{}",
  ];
  for (const text of invalid) {
    assert.throws(
      () => parseCanonicalJson(text),
      (error: unknown) =>
        error instanceof ProtocolError &&
        error.code === "invalid_canonical_json",
    );
  }
  assert.throws(
    () => parseCanonicalJson(new Uint8Array([0x22, 0xc0, 0xaf, 0x22])),
    ProtocolError,
  );
  assert.throws(
    () => parseCanonicalJson(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d])),
    ProtocolError,
  );
  assert.throws(
    () => parseCanonicalJson(" ".repeat(65_537)),
    (error: unknown) =>
      error instanceof ProtocolError && error.code === "limit_exceeded",
  );
});

test("canonical JSON enforces a bounded tree and UTF-8 output budget", () => {
  const limitError = (error: unknown) =>
    error instanceof ProtocolError && error.code === "limit_exceeded";
  assert.equal(
    canonicalJson("a".repeat(CANONICAL_LIMITS.maxBytes - 2)).length,
    CANONICAL_LIMITS.maxBytes,
  );
  assert.throws(() => canonicalJson("é".repeat(32_768)), limitError);
  assert.throws(
    () => canonicalJson(Array.from({ length: 257 }, () => 0)),
    limitError,
  );
  assert.throws(
    () =>
      canonicalJson(
        Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`k${i}`, i])),
      ),
    limitError,
  );
  let nested: unknown = 0;
  for (let depth = 0; depth < 16; depth++) nested = [nested];
  assert.doesNotThrow(() => canonicalJson(nested));
  assert.throws(() => canonicalJson([nested]), limitError);
  assert.throws(
    () =>
      canonicalJson(
        Array.from({ length: 17 }, () => Array.from({ length: 256 }, () => 0)),
      ),
    limitError,
  );
  assert.throws(
    () => canonicalJson(["x".repeat(40_000), "x".repeat(40_000)]),
    limitError,
  );
});

test("canonical JSON rejects values that JSON would omit, round, or transform", () => {
  for (const value of [
    undefined,
    NaN,
    Infinity,
    0.5,
    -0,
    9_007_199_254_740_992,
    1n,
    new Date(0),
    { a: undefined },
    [undefined],
    "\ud800",
  ]) {
    assert.throws(
      () => canonicalJson(value),
      (error: unknown) =>
        error instanceof ProtocolError &&
        error.code === "invalid_canonical_json",
    );
  }

  let getterCalled = false;
  const accessor = {
    get value() {
      getterCalled = true;
      return 1;
    },
  };
  assert.throws(() => canonicalJson(accessor));
  assert.equal(getterCalled, false);
  assert.throws(() => canonicalJson(new Array(2)));
  assert.throws(() => canonicalJson({ [Symbol("hidden")]: 1 }));
});

test("canonical boundaries reject cycles without rejecting shared acyclic values", () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(() => canonicalJson(cyclic), ProtocolError);
  const shared = { fact: true };
  assert.equal(
    canonicalJson([shared, shared]),
    '[{"fact":true},{"fact":true}]',
  );
  assert.throws(
    () => canonicalJson(Object.defineProperty({}, "hidden", { value: 1 })),
    ProtocolError,
  );
  assert.throws(
    () => parseCanonicalJson(null as unknown as string),
    ProtocolError,
  );
});

test("boundary diagnostics never include rejected input", () => {
  const secret = "private-claim-and-credential";
  assert.throws(
    () => parseCanonicalJson(secret),
    (error: unknown) => {
      assert.ok(error instanceof ProtocolError);
      assert.equal(error.code, "invalid_canonical_json");
      assert.equal(error.message.includes(secret), false);
      return true;
    },
  );
});
