import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { type EvidencePayload } from "../src/evidence-v2.js";
import {
  parsePublicEvidenceDocument,
  publicEvidenceDocumentDigest,
} from "../src/public-evidence-document-v1.js";
import { canonicalDigest, canonicalJson } from "../src/canonical.js";
import { ProtocolError } from "../src/protocol-errors.js";

const fixture = JSON.parse(
  fs.readFileSync(
    new URL("./fixtures/v2-public-evidence-document.json", import.meta.url),
    "utf8",
  ),
) as {
  valid: Record<string, any>;
};

function expectCode(action: () => unknown, code: ProtocolError["code"]): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof ProtocolError);
    assert.equal(error.code, code);
    return true;
  });
}

function validDocument(): Record<string, any> {
  return structuredClone(fixture.valid);
}

function refreshDigest(document: Record<string, any>): void {
  document.digest = canonicalDigest("evidence", document.evidence);
}

function externalDigest(hexCharacter: string): string {
  return `sha256:${hexCharacter.repeat(64)}`;
}

test("parses the public evidence document and preserves its exact digest", () => {
  const parsed = parsePublicEvidenceDocument(fixture.valid);

  assert.equal(parsed.digest, fixture.valid.digest);
  assert.equal(
    publicEvidenceDocumentDigest(fixture.valid),
    fixture.valid.digest,
  );
  assert.equal(canonicalJson(parsed), canonicalJson(fixture.valid));
  assert.equal(parsed.evidence.access.visibility, "public");
  assert.deepEqual(parsed.links, []);
});

test("rejects top-level unknown fields and digest tampering", () => {
  const unknownField = validDocument();
  unknownField.transport = "http";
  expectCode(
    () => parsePublicEvidenceDocument(unknownField),
    "invalid_request",
  );

  const tamperedDigest = validDocument();
  tamperedDigest.digest = externalDigest("a");
  expectCode(
    () => parsePublicEvidenceDocument(tamperedDigest),
    "digest_mismatch",
  );

  const tamperedEvidence = validDocument();
  tamperedEvidence.evidence.claim.value.value = false;
  expectCode(
    () => parsePublicEvidenceDocument(tamperedEvidence),
    "digest_mismatch",
  );
});

test("rejects private evidence and private source locations", () => {
  const privateNode = validDocument();
  privateNode.evidence.access = {
    visibility: "owner",
    owner: {
      chain_id: "4663",
      address: "0x1111111111111111111111111111111111111111",
    },
    policy_revision: "private-v1",
  };
  refreshDigest(privateNode);
  expectCode(() => parsePublicEvidenceDocument(privateNode), "invalid_lineage");

  const privateSource = validDocument();
  privateSource.evidence.sources[0].location = {
    visibility: "owner",
    reference: "private-source",
  };
  refreshDigest(privateSource);
  expectCode(
    () => parsePublicEvidenceDocument(privateSource),
    "invalid_evidence",
  );
});

test("accepts a public correction link whose child is the requested document", () => {
  const document = validDocument();
  const parentDigest = externalDigest("d");
  document.evidence.supersedes = parentDigest;
  document.evidence.correction_reason = "Corrects a prior public observation.";
  refreshDigest(document);
  document.links = [
    {
      child_digest: document.digest,
      relationship: "supersedes",
      parent_digest: parentDigest,
      correction_reason: document.evidence.correction_reason,
    },
  ];

  const parsed = parsePublicEvidenceDocument(document);

  assert.equal(parsed.links[0]!.parent_digest, parentDigest);
});

test("accepts an incoming public relationship when the requested digest is the parent", () => {
  const document = validDocument();
  const childDigest = externalDigest("e");
  document.links = [
    {
      child_digest: childDigest,
      relationship: "derived_from",
      parent_digest: document.digest,
      correction_reason: null,
    },
  ];

  assert.doesNotThrow(() => parsePublicEvidenceDocument(document));
});

test("rejects a document when an outgoing evidence reference has no link", () => {
  const document = validDocument();
  const parentDigest = externalDigest("d");
  document.evidence.conflicts_with = [parentDigest];
  refreshDigest(document);

  document.links = [];

  expectCode(() => parsePublicEvidenceDocument(document), "invalid_lineage");
});

test("rejects malformed, unrelated, and inconsistent links", () => {
  const unknownField = validDocument();
  unknownField.links = [
    {
      child_digest: unknownField.digest,
      relationship: "derived_from",
      parent_digest: externalDigest("d"),
      correction_reason: null,
      visibility: "owner",
    },
  ];
  expectCode(
    () => parsePublicEvidenceDocument(unknownField),
    "invalid_lineage",
  );

  const unrelated = validDocument();
  unrelated.links = [
    {
      child_digest: externalDigest("a"),
      relationship: "derived_from",
      parent_digest: externalDigest("b"),
      correction_reason: null,
    },
  ];
  expectCode(() => parsePublicEvidenceDocument(unrelated), "invalid_lineage");

  const inconsistent = validDocument();
  inconsistent.links = [
    {
      child_digest: inconsistent.digest,
      relationship: "derived_from",
      parent_digest: externalDigest("d"),
      correction_reason: null,
    },
  ];
  expectCode(
    () => parsePublicEvidenceDocument(inconsistent),
    "invalid_lineage",
  );

  const invalidCorrection = validDocument();
  invalidCorrection.links = [
    {
      child_digest: invalidCorrection.digest,
      relationship: "conflicts_with",
      parent_digest: externalDigest("d"),
      correction_reason: "Only supersedes links can explain a correction.",
    },
  ];
  expectCode(
    () => parsePublicEvidenceDocument(invalidCorrection),
    "invalid_lineage",
  );

  const mismatchedCorrection = validDocument();
  const parentDigest = externalDigest("d");
  mismatchedCorrection.evidence.supersedes = parentDigest;
  mismatchedCorrection.evidence.correction_reason = "Actual correction.";
  refreshDigest(mismatchedCorrection);
  mismatchedCorrection.links = [
    {
      child_digest: mismatchedCorrection.digest,
      relationship: "supersedes",
      parent_digest: parentDigest,
      correction_reason: "Different explanation.",
    },
  ];
  expectCode(
    () => parsePublicEvidenceDocument(mismatchedCorrection),
    "invalid_lineage",
  );
});

test("rejects links that are not strictly ordered or exceed the limit", () => {
  const document = validDocument();
  const firstParent = externalDigest("a");
  const secondParent = externalDigest("b");
  const evidence = document.evidence as EvidencePayload;
  evidence.conflicts_with = [firstParent, secondParent];
  refreshDigest(document);
  document.links = [
    {
      child_digest: document.digest,
      relationship: "conflicts_with",
      parent_digest: secondParent,
      correction_reason: null,
    },
    {
      child_digest: document.digest,
      relationship: "conflicts_with",
      parent_digest: firstParent,
      correction_reason: null,
    },
  ];
  expectCode(() => parsePublicEvidenceDocument(document), "invalid_lineage");

  const tooMany = validDocument();
  tooMany.links = Array.from({ length: 257 }, () => ({
    child_digest: tooMany.digest,
    relationship: "derived_from",
    parent_digest: externalDigest("d"),
    correction_reason: null,
  }));
  expectCode(() => parsePublicEvidenceDocument(tooMany), "limit_exceeded");
});
