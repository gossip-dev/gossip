import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { canonicalDigest, canonicalJson } from "../src/canonical.js";
import {
  parseEvidenceEnvelope,
  parseEvidenceGraph,
  parseResultManifest,
  validateResultPacket,
} from "../src/evidence-v2.js";
import {
  parseSignedReceipt,
  validateReceiptConsultation,
} from "../src/receipts-v2.js";

type DigestDomain = "evidence" | "receipt";

type Fixture = {
  objects: Record<string, any>;
  literals: Record<
    string,
    {
      domain: DigestDomain;
      value: unknown;
      canonical: string;
      digest: string;
    }
  >;
  graphs: Record<string, { value: unknown; canonical: string }>;
};

const fixture = JSON.parse(
  fs.readFileSync(
    new URL("./fixtures/v2-evidence-receipts.json", import.meta.url),
    "utf8",
  ),
) as Fixture;

test("independent evidence and receipt literals match canonical bytes and digests", () => {
  for (const [name, literal] of Object.entries(fixture.literals)) {
    assert.equal(canonicalJson(literal.value), literal.canonical, name);
    assert.equal(
      canonicalDigest(literal.domain, literal.value),
      literal.digest,
      name,
    );
  }

  for (const [name, graph] of Object.entries(fixture.graphs)) {
    assert.equal(canonicalJson(graph.value), graph.canonical, name);
  }
});

test("independent vectors pass the public evidence and receipt entry points", () => {
  const objects = fixture.objects;

  for (const name of [
    "chainEvidence",
    "sourceUnknownEvidence",
    "researchEvidence",
    "correctionEvidence",
  ]) {
    parseEvidenceEnvelope(objects[name]);
  }

  const graph = parseEvidenceGraph(objects.publicGraph);
  parseEvidenceGraph(objects.ownerGraph);
  parseResultManifest(objects.resultManifest);
  validateResultPacket(objects.resultManifest, graph);

  for (const name of [
    "acknowledgment",
    "pendingReceipt",
    "completeReceipt",
    "partialReceipt",
    "rejectedReceipt",
    "reconciliationReceipt",
  ]) {
    const parsed = parseSignedReceipt(objects[name]);
    assert.deepEqual(parseSignedReceipt(parsed), parsed);
    validateReceiptConsultation(objects[name], objects.consultation);
  }
});
