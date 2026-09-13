import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  publicSubmissionDigest,
  parsePublicSubmission,
} from "../src/public-submission-v1.js";
import { evidenceDigest, parseEvidenceGraph } from "../src/evidence-v2.js";
import { canonicalJson } from "../src/canonical.js";
import { ProtocolError } from "../src/protocol-errors.js";

const fixture = JSON.parse(
  fs.readFileSync(
    new URL("./fixtures/v2-public-submission.json", import.meta.url),
    "utf8",
  ),
) as {
  valid: Record<string, unknown>;
  canonical: string;
  digest: string;
};

function expectCode(action: () => unknown, code: ProtocolError["code"]): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof ProtocolError);
    assert.equal(error.code, code);
    return true;
  });
}

function submissionWithPublicParent(
  relation: "derived_from" | "conflicts_with",
): Record<string, any> {
  const submission = structuredClone(fixture.valid);
  const graph = submission.evidence as {
    roots: string[];
    bundles: Array<{ digest: string; evidence: Record<string, any> }>;
  };
  const root = graph.bundles[0]!;
  const parentEvidence = structuredClone(root.evidence);
  const parentDigest = evidenceDigest(parentEvidence);

  root.evidence[relation] = [parentDigest];
  root.digest = evidenceDigest(root.evidence);
  graph.bundles.push({ digest: parentDigest, evidence: parentEvidence });
  graph.roots = [root.digest];
  submission.result.evidence_digests = [root.digest];

  return submission;
}

function submissionWithExternalLineage(
  relation: "supersedes" | "conflicts_with",
): Record<string, any> {
  const submission = structuredClone(fixture.valid);
  const graph = submission.evidence as {
    roots: string[];
    bundles: Array<{ digest: string; evidence: Record<string, any> }>;
  };
  const root = graph.bundles[0]!;
  const externalDigest = "sha256:" + "d".repeat(64);

  if (relation === "supersedes") {
    root.evidence.supersedes = externalDigest;
    root.evidence.correction_reason = "Corrects a prior public observation.";
  } else {
    root.evidence.conflicts_with = [externalDigest];
  }

  root.digest = evidenceDigest(root.evidence);
  graph.roots = [root.digest];
  submission.result.evidence_digests = [root.digest];

  return submission;
}

test("parses a public-only submission and binds its request digest", () => {
  const parsed = parsePublicSubmission(fixture.valid);

  assert.equal(publicSubmissionDigest(fixture.valid), fixture.digest);
  assert.equal(canonicalJson(parsed), fixture.canonical);
  assert.equal(parsed.max_cost.amount, "0");
  assert.deepEqual(parsed.result.evidence_digests, parsed.evidence.roots);
});

test("rejects private nodes, private links, and private sources", () => {
  const privateNode = structuredClone(fixture.valid);
  const graph = privateNode.evidence as { bundles: Array<Record<string, any>> };
  graph.bundles[0]!.evidence.access = {
    visibility: "owner",
    owner: fixture.valid.actor as object,
    policy_revision: "synthetic",
  };
  graph.bundles[0]!.digest = evidenceDigest(graph.bundles[0]!.evidence);
  (privateNode.evidence as Record<string, any>).roots = [
    graph.bundles[0]!.digest,
  ];
  (privateNode.result as Record<string, any>).evidence_digests = [
    graph.bundles[0]!.digest,
  ];
  expectCode(() => parsePublicSubmission(privateNode), "invalid_lineage");

  const privateSource = structuredClone(fixture.valid);
  const sourceGraph = privateSource.evidence as {
    bundles: Array<Record<string, any>>;
  };
  sourceGraph.bundles[0]!.evidence.sources[0].location = {
    visibility: "owner",
    reference: "private-ref",
  };
  expectCode(() => parsePublicSubmission(privateSource), "invalid_evidence");

  const privateLink = structuredClone(fixture.valid);
  const linkGraph = privateLink.evidence as {
    bundles: Array<Record<string, any>>;
  };
  const privateEvidence = structuredClone(linkGraph.bundles[0]!.evidence);
  privateEvidence.access = {
    visibility: "owner",
    owner: fixture.valid.actor as object,
    policy_revision: "synthetic",
  };
  privateEvidence.sources[0].location = {
    visibility: "owner",
    reference: "private-source",
  };
  const privateDigest = evidenceDigest(privateEvidence);
  linkGraph.bundles.push({
    digest: privateDigest,
    evidence: privateEvidence,
  });
  linkGraph.bundles[0]!.evidence.derived_from = [privateDigest];
  linkGraph.bundles[0]!.digest = evidenceDigest(linkGraph.bundles[0]!.evidence);
  (privateLink.evidence as Record<string, any>).roots = [
    linkGraph.bundles[0]!.digest,
  ];
  (privateLink.result as Record<string, any>).evidence_digests = [
    linkGraph.bundles[0]!.digest,
  ];
  expectCode(() => parsePublicSubmission(privateLink), "invalid_lineage");
});

test("rejects root mismatch, nonzero cost, and canonical tampering", () => {
  const mismatchedRoots = structuredClone(fixture.valid);
  (mismatchedRoots.result as Record<string, unknown>).evidence_digests = [
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  ];
  expectCode(() => parsePublicSubmission(mismatchedRoots), "digest_mismatch");

  const nonzeroCost = structuredClone(fixture.valid);
  (nonzeroCost.max_cost as Record<string, unknown>).amount = "1";
  expectCode(() => parsePublicSubmission(nonzeroCost), "invalid_request");

  const tampered = structuredClone(fixture.valid);
  (tampered as Record<string, unknown>).operation_id = "different-operation";
  assert.notEqual(publicSubmissionDigest(tampered), fixture.digest);
});

test("accepts closed public derivation and rejects bundled mutation targets", () => {
  const derived = parsePublicSubmission(
    submissionWithPublicParent("derived_from"),
  );
  assert.equal(derived.evidence.bundles.length, 2);

  expectCode(
    () => parsePublicSubmission(submissionWithPublicParent("conflicts_with")),
    "invalid_lineage",
  );
});

test("accepts external public corrections and conflicts", () => {
  const externalSupersedes = submissionWithExternalLineage("supersedes");
  const externalConflicts = submissionWithExternalLineage("conflicts_with");
  assert.doesNotThrow(() => parsePublicSubmission(externalSupersedes));
  assert.doesNotThrow(() => parsePublicSubmission(externalConflicts));
  expectCode(
    () => parseEvidenceGraph(externalSupersedes.evidence),
    "evidence_unavailable",
  );

  const bundledSupersedes = submissionWithPublicParent("derived_from");
  const graph = bundledSupersedes.evidence as {
    bundles: Array<{ digest: string; evidence: Record<string, any> }>;
  };
  const root = graph.bundles[0]!;
  root.evidence.supersedes = graph.bundles[1]!.digest;
  root.evidence.correction_reason = "Bundled references are not allowed.";
  root.digest = evidenceDigest(root.evidence);
  (bundledSupersedes.evidence as Record<string, any>).roots = [root.digest];
  (bundledSupersedes.result as Record<string, any>).evidence_digests = [
    root.digest,
  ];
  expectCode(() => parsePublicSubmission(bundledSupersedes), "invalid_lineage");
});

test("reuses v2 actor, endpoint, audience, and operation rules", () => {
  for (const field of ["actor", "endpoint", "audience", "operation_id"]) {
    const invalid = structuredClone(fixture.valid);
    if (field === "actor") {
      (invalid.actor as Record<string, unknown>).address = "0xnot-an-address";
    } else if (field === "endpoint" || field === "audience") {
      (invalid as Record<string, unknown>)[field] = "http://localhost/";
    } else {
      (invalid as Record<string, unknown>)[field] = "";
    }
    expectCode(() => parsePublicSubmission(invalid), "invalid_request");
  }
});
