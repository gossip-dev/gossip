import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  parseSignedPublicSubmissionReceipt,
  publicSubmissionReceiptDigest,
  validatePublicSubmissionReceipt,
  verifyPublicSubmissionReceipt,
} from "../src/public-submission-receipt-v1.js";
import { ProtocolError } from "../src/protocol-errors.js";

const fixture = JSON.parse(
  fs.readFileSync(
    new URL("./fixtures/v2-public-submission-receipt.json", import.meta.url),
    "utf8",
  ),
) as {
  receipt: Record<string, unknown>;
  manifest: Record<string, unknown>;
};

const submissionFixture = JSON.parse(
  fs.readFileSync(
    new URL("./fixtures/v2-public-submission.json", import.meta.url),
    "utf8",
  ),
) as { valid: Record<string, unknown> };

function expectCode(action: () => unknown, code: ProtocolError["code"]): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof ProtocolError);
    assert.equal(error.code, code);
    return true;
  });
}

test("verifies the public-submission receipt vector", () => {
  const parsed = parseSignedPublicSubmissionReceipt(fixture.receipt);
  const verified = verifyPublicSubmissionReceipt(
    fixture.receipt,
    fixture.manifest,
  );

  assert.equal(parsed.receipt.operation_kind, "public_submission");
  assert.equal(
    publicSubmissionReceiptDigest(fixture.receipt.receipt),
    fixture.receipt.receipt_digest,
  );
  assert.equal(parsed.receipt.status, "complete");
  assert.deepEqual(parsed.receipt.max_cost, {
    unit: "earned_credit",
    amount: "0",
  });
  assert.deepEqual(parsed.receipt.economics, {
    unit: "earned_credit",
    state: "settled",
    reserved_amount: "0",
    charged_amount: "0",
  });
  assert.equal(verified.signer.key_id, "receipt-key-1");
  assert.deepEqual(
    validatePublicSubmissionReceipt(fixture.receipt, submissionFixture.valid),
    parsed,
  );
});

test("rejects nonzero economics and unknown response fields", () => {
  const nonzero = structuredClone(fixture.receipt);
  (nonzero.receipt as Record<string, any>).economics.charged_amount = "1";
  expectCode(
    () => parseSignedPublicSubmissionReceipt(nonzero),
    "invalid_receipt",
  );

  const invented = structuredClone(fixture.receipt);
  (invented.receipt as Record<string, unknown>).already_persisted = false;
  expectCode(
    () => parseSignedPublicSubmissionReceipt(invented),
    "invalid_receipt",
  );
});

test("rejects identity, endpoint, and evidence digest tampering", () => {
  const actorTampered = structuredClone(fixture.receipt);
  (actorTampered.receipt as Record<string, any>).owner.address =
    "0x2222222222222222222222222222222222222222";
  expectCode(
    () => parseSignedPublicSubmissionReceipt(actorTampered),
    "invalid_receipt",
  );

  const endpointTampered = structuredClone(fixture.receipt);
  (endpointTampered.receipt as Record<string, unknown>).endpoint =
    "http://gossip.example/mcp";
  expectCode(
    () => parseSignedPublicSubmissionReceipt(endpointTampered),
    "invalid_receipt",
  );

  const evidenceTampered = structuredClone(fixture.receipt);
  (evidenceTampered.receipt as Record<string, any>).evidence_digests = [
    "sha256:" + "f".repeat(64),
  ];
  expectCode(
    () => parseSignedPublicSubmissionReceipt(evidenceTampered),
    "digest_mismatch",
  );
});

test("keeps the signed envelope identical for the first call and retry", () => {
  const first = parseSignedPublicSubmissionReceipt(fixture.receipt);
  const retry = parseSignedPublicSubmissionReceipt(
    structuredClone(fixture.receipt),
  );

  assert.deepEqual(retry, first);
  assert.equal("already_persisted" in first.receipt, false);
});

test("rejects a receipt bound to a different public submission", () => {
  const changed = structuredClone(submissionFixture.valid);
  changed.operation_id = "different-public-submission";

  expectCode(
    () => validatePublicSubmissionReceipt(fixture.receipt, changed),
    "invalid_receipt",
  );
});
