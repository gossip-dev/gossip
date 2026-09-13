import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  PROTOCOL_REVISION,
  canonicalDigest,
  canonicalJson,
  parseCanonicalJson,
} from "../src/canonical.js";
import { ProtocolError } from "../src/protocol-errors.js";

type DigestDomain = "request" | "evidence" | "receipt";

type Fixture = {
  protocolRevision: string;
  valid: Array<{
    name: string;
    value: unknown;
    canonical: string;
    digests: Record<DigestDomain, string>;
  }>;
  invalid: Array<{
    name: string;
    kind: string;
    raw?: string;
    rawBase64?: string;
  }>;
};

const fixture = JSON.parse(
  readFileSync(
    new URL("./fixtures/v2-canonical.json", import.meta.url),
    "utf8",
  ),
) as Fixture;

test("v2 canonical vectors match literal canonical strings and independent digests", () => {
  assert.equal(PROTOCOL_REVISION, fixture.protocolRevision);

  for (const vector of fixture.valid) {
    assert.equal(canonicalJson(vector.value), vector.canonical, vector.name);
    assert.deepEqual(
      parseCanonicalJson(vector.canonical),
      vector.value,
      vector.name,
    );

    for (const domain of ["request", "evidence", "receipt"] as const) {
      assert.equal(
        canonicalDigest(domain, vector.value),
        vector.digests[domain],
        `${vector.name} / ${domain}`,
      );
    }
  }
});

test("v2 canonical decoder rejects every invalid raw vector", () => {
  for (const vector of fixture.invalid) {
    const raw = vector.rawBase64
      ? Uint8Array.from(Buffer.from(vector.rawBase64, "base64"))
      : vector.raw;
    if (raw === undefined) {
      throw new Error(`${vector.name} has no raw input`);
    }

    const expectedCode = [
      "byte-limit",
      "depth-limit",
      "array-limit",
      "object-limit",
      "node-limit",
    ].includes(vector.kind)
      ? "limit_exceeded"
      : "invalid_canonical_json";

    assert.throws(
      () => parseCanonicalJson(raw),
      (error: unknown) => {
        assert.ok(error instanceof ProtocolError);
        assert.equal(error.code, expectedCode, vector.name);
        return true;
      },
      vector.name,
    );
  }
});

test("v2 digests separate domains and detect payload tampering", () => {
  const vector = fixture.valid[0];
  assert.ok(vector);

  assert.notEqual(
    canonicalDigest("request", vector.value),
    canonicalDigest("evidence", vector.value),
  );

  const tampered = {
    ...(vector.value as Record<string, unknown>),
    integer: -41,
  };
  assert.notEqual(
    canonicalDigest("request", vector.value),
    canonicalDigest("request", tampered),
  );
});
