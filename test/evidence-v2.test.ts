import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  assessEvidenceGraph,
  evidenceDigest,
  parseEvidenceEnvelope,
  parseEvidenceGraph,
  parseResultManifest,
  validateResultPacket,
} from "../src/evidence-v2.js";
import { ProtocolError } from "../src/protocol-errors.js";

const fixture = JSON.parse(
  fs.readFileSync(
    new URL("./fixtures/v2-evidence-receipts.json", import.meta.url),
    "utf8",
  ),
) as { objects: Record<string, any> };

test("parses frozen evidence envelopes, graphs, and manifest roots", () => {
  const objects = fixture.objects;
  for (const name of [
    "chainEvidence",
    "sourceUnknownEvidence",
    "researchEvidence",
    "correctionEvidence",
  ])
    parseEvidenceEnvelope(objects[name]);
  const graph = parseEvidenceGraph(objects.publicGraph);
  parseEvidenceGraph(objects.ownerGraph);
  parseResultManifest(objects.resultManifest);
  assert.deepEqual(
    validateResultPacket(objects.resultManifest, graph).evidence_digests,
    graph.roots,
  );
});

test("rejects wrong outer names and tampered digest", () => {
  const envelope = fixture.objects.chainEvidence;
  const wrong = { ...envelope } as Record<string, unknown>;
  delete wrong.evidence;
  (wrong as Record<string, unknown>).payload = envelope.evidence;
  assert.throws(
    () => parseEvidenceEnvelope(wrong),
    (error: unknown) =>
      error instanceof ProtocolError && error.code === "invalid_evidence",
  );
  assert.throws(
    () =>
      parseEvidenceEnvelope({
        ...envelope,
        digest: `sha256:${"0".repeat(64)}`,
      }),
    (error: unknown) =>
      error instanceof ProtocolError && error.code === "digest_mismatch",
  );
});

test("assesses explicit temporal and finality boundaries", () => {
  const graph = fixture.objects.publicGraph;
  const result = assessEvidenceGraph(graph, {
    now: 1700000010,
    max_age_seconds: 20,
    finality: "latest",
  });
  assert.equal(result.valid, false);
  assert.ok(result.reasons.includes("future"));
  const stale = assessEvidenceGraph(graph, {
    now: 1700001000,
    max_age_seconds: 20,
    finality: "finalized",
  });
  assert.equal(stale.valid, false);
  assert.ok(
    stale.reasons.includes("expired") || stale.reasons.includes("stale"),
  );
});

test("enforces canonical evidence values, replay source closure, and snapshot validity", () => {
  const source = fixture.objects.sourceUnknownEvidence;
  const decimal = {
    ...source.evidence,
    claim: {
      ...source.evidence.claim,
      value: { state: "known", type: "decimal", value: "1.0" },
    },
  };
  assert.throws(
    () =>
      parseEvidenceEnvelope({
        digest: evidenceDigest(decimal),
        evidence: decimal,
      }),
    (error: unknown) =>
      error instanceof ProtocolError && error.code === "invalid_evidence",
  );
  const unavailable = {
    ...source.evidence,
    verification: {
      mode: "replay",
      method: "x",
      revision: "1",
      source_ids: ["missing"],
      instructions: "x",
    },
  };
  assert.throws(
    () =>
      parseEvidenceEnvelope({
        digest: evidenceDigest(unavailable),
        evidence: unavailable,
      }),
    (error: unknown) =>
      error instanceof ProtocolError && error.code === "invalid_evidence",
  );
  const snapshot = {
    ...source.evidence,
    validity: {
      ...source.evidence.validity,
      basis: { type: "snapshot" },
    },
  };
  parseEvidenceEnvelope({
    digest: evidenceDigest(snapshot),
    evidence: snapshot,
  });

  const canonicalNegative = {
    ...source.evidence,
    claim: {
      ...source.evidence.claim,
      value: {
        state: "known",
        type: "decimal",
        value: "-12.5",
        unit: "wallets",
      },
    },
  };
  assert.doesNotThrow(() => evidenceDigest(canonicalNegative));

  for (const value of [
    "-0",
    "1.20",
    "1.0",
    "1.2.3",
    "1.2.bad",
    "1".repeat(79),
  ]) {
    const invalidDecimal = {
      ...canonicalNegative,
      claim: {
        ...canonicalNegative.claim,
        value: { ...canonicalNegative.claim.value, value },
      },
    };
    assert.throws(
      () => evidenceDigest(invalidDecimal),
      (error: unknown) =>
        error instanceof ProtocolError && error.code === "invalid_evidence",
    );
  }
});

test("malformed discriminators and lineage fail with protocol errors", () => {
  const source = fixture.objects.sourceUnknownEvidence;
  const malformedReason = {
    ...source.evidence,
    claim: {
      ...source.evidence.claim,
      value: { state: "unknown", reason: ["not_measured"] },
    },
  };
  assert.throws(
    () => evidenceDigest(malformedReason),
    (error: unknown) =>
      error instanceof ProtocolError && error.code === "invalid_evidence",
  );

  const malformedLineage = {
    ...fixture.objects.researchEvidence.evidence,
    derived_from: null,
  };
  assert.throws(
    () => evidenceDigest(malformedLineage),
    (error: unknown) =>
      error instanceof ProtocolError && error.code === "invalid_evidence",
  );

  assert.throws(
    () =>
      assessEvidenceGraph(fixture.objects.publicGraph, {
        now: 1700000010,
        max_age_seconds: 20,
        finality: "not-a-finality" as "latest",
      }),
    (error: unknown) =>
      error instanceof ProtocolError && error.code === "invalid_evidence",
  );

  assert.throws(
    () => assessEvidenceGraph(fixture.objects.publicGraph, null as never),
    (error: unknown) =>
      error instanceof ProtocolError && error.code === "invalid_evidence",
  );
});

test("enforces graph closure and owner privacy before digest consistency", () => {
  const graph = structuredClone(fixture.objects.publicGraph);
  graph.bundles = graph.bundles.filter(
    (bundle: Record<string, any>) =>
      bundle.digest !== fixture.objects.sourceUnknownEvidence.digest,
  );
  assert.throws(
    () => parseEvidenceGraph(graph),
    (error: unknown) =>
      error instanceof ProtocolError && error.code === "evidence_unavailable",
  );

  const ownerGraph = structuredClone(fixture.objects.ownerGraph);
  const root = ownerGraph.bundles.find(
    (bundle: Record<string, any>) => bundle.digest === ownerGraph.roots[0],
  );
  root.evidence.access = { visibility: "public" };
  root.evidence.sources[0].location = {
    visibility: "public",
    uri: "https://evidence.test/public-copy.json",
  };
  assert.throws(
    () => parseEvidenceGraph(ownerGraph),
    (error: unknown) =>
      error instanceof ProtocolError && error.code === "invalid_lineage",
  );
});
