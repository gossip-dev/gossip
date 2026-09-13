import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  parseSignedReceipt,
  receiptDigest,
  validateReceiptTransitionChain,
} from "../src/receipts-v2.js";
import { ProtocolError } from "../src/protocol-errors.js";

const fixture = JSON.parse(
  fs.readFileSync(
    new URL("./fixtures/v2-evidence-receipts.json", import.meta.url),
    "utf8",
  ),
) as { objects: Record<string, any> };
const objects = fixture.objects;

test("parses every lifecycle state without claiming signature authenticity", () => {
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
  }
  const request = objects.consultation;
  const chain = validateReceiptTransitionChain(
    [objects.acknowledgment, objects.pendingReceipt, objects.completeReceipt],
    request,
    1800000000,
  );
  assert.equal(chain.length, 3);
});

test("rejects wrong outer names, digest tampering, and transition mismatches", () => {
  const receipt = objects.acknowledgment;
  const wrong = { ...receipt } as Record<string, unknown>;
  delete wrong.receipt;
  wrong.payload = receipt.receipt;
  assert.throws(
    () => parseSignedReceipt(wrong),
    (error: unknown) =>
      error instanceof ProtocolError && error.code === "invalid_receipt",
  );
  assert.throws(
    () =>
      parseSignedReceipt({
        ...receipt,
        receipt_digest: `sha256:${"0".repeat(64)}`,
      }),
    (error: unknown) =>
      error instanceof ProtocolError && error.code === "digest_mismatch",
  );
  const altered = {
    ...objects.pendingReceipt,
    receipt: {
      ...objects.pendingReceipt.receipt,
      previous_receipt_digest: `sha256:${"0".repeat(64)}`,
    },
  };
  assert.throws(
    () => validateReceiptTransitionChain([objects.acknowledgment, altered]),
    (error: unknown) =>
      error instanceof ProtocolError && error.code === "digest_mismatch",
  );
});

test("enforces signature encoding and terminal immutability", () => {
  const complete = objects.completeReceipt;
  assert.throws(
    () =>
      parseSignedReceipt({ ...complete, signature: `${complete.signature}=` }),
    (error: unknown) =>
      error instanceof ProtocolError && error.code === "invalid_receipt",
  );
  const changed = {
    ...complete,
    receipt: {
      ...complete.receipt,
      server: { ...complete.receipt.server, id: "other" },
    },
  };
  changed.receipt_digest = receiptDigest(changed.receipt);
  assert.throws(
    () =>
      validateReceiptTransitionChain([
        objects.acknowledgment,
        objects.pendingReceipt,
        complete,
        changed,
      ]),
    (error: unknown) =>
      error instanceof ProtocolError && error.code === "invalid_receipt",
  );
  assert.doesNotThrow(() =>
    validateReceiptTransitionChain([
      objects.acknowledgment,
      objects.pendingReceipt,
      complete,
      complete,
    ]),
  );
});

test("enforces exact receipt state invariants and reconciliation recovery", () => {
  const pendingWithCharge = structuredClone(objects.pendingReceipt);
  pendingWithCharge.receipt.economics.charged_amount = "0";
  assert.throws(
    () => receiptDigest(pendingWithCharge.receipt),
    (error: unknown) =>
      error instanceof ProtocolError && error.code === "invalid_receipt",
  );

  const rejectedWithWrongError = structuredClone(objects.rejectedReceipt);
  rejectedWithWrongError.receipt.error_code = "operation_conflict";
  assert.throws(
    () => receiptDigest(rejectedWithWrongError.receipt),
    (error: unknown) =>
      error instanceof ProtocolError && error.code === "invalid_receipt",
  );

  const recovered = structuredClone(objects.completeReceipt);
  recovered.receipt.sequence = 3;
  recovered.receipt.previous_receipt_digest =
    objects.reconciliationReceipt.receipt_digest;
  recovered.receipt.issued_at = 1800000003;
  recovered.receipt.server.revision = "synthetic-v2";
  recovered.receipt_digest = receiptDigest(recovered.receipt);
  assert.doesNotThrow(() =>
    validateReceiptTransitionChain([
      objects.acknowledgment,
      objects.pendingReceipt,
      objects.reconciliationReceipt,
      recovered,
    ]),
  );
});

test("rejects non-string states and oversized receipt chains", () => {
  const arrayState = structuredClone(objects.pendingReceipt.receipt);
  arrayState.status = ["pending"];
  arrayState.economics.charged_amount = "1";
  assert.throws(
    () => receiptDigest(arrayState),
    (error: unknown) =>
      error instanceof ProtocolError && error.code === "invalid_receipt",
  );

  const oversized = Array.from({ length: 103 }, () => objects.acknowledgment);
  assert.throws(
    () => validateReceiptTransitionChain(oversized),
    (error: unknown) =>
      error instanceof ProtocolError && error.code === "limit_exceeded",
  );
});
