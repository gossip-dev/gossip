import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { Wallet } from "ethers";
import {
  parseReceiptTrustManifest,
  receiptSigningMessage,
  verifyConsultationReceiptAuthenticity,
  verifyReceiptTransitionChainAuthenticity,
  verifySignedReceipt,
} from "../src/receipt-auth.js";
import { receiptDigest } from "../src/receipts-v2.js";
import { ProtocolError } from "../src/protocol-errors.js";

const fixture = JSON.parse(
  fs.readFileSync(
    new URL("./fixtures/v2-receipt-auth.json", import.meta.url),
    "utf8",
  ),
) as {
  manifest: Record<string, unknown>;
  receipt: Record<string, unknown>;
  message: string;
};

const keyOne = new Wallet(`0x${"00".repeat(31)}01`);
const keyTwo = new Wallet(`0x${"00".repeat(31)}02`);

function manifestFor(
  wallet: Wallet,
  status: "active" | "retired" | "revoked" = "active",
  validFrom = 1_799_990_000,
  validUntil = 1_800_003_600,
): Record<string, unknown> {
  return {
    schema: "gossip.receipt-trust-manifest.v1",
    server_id: "sherwood",
    profile: "gossip-eip191-receipt-v1",
    keys: [
      {
        key_id: "receipt-key-1",
        public_key: wallet.signingKey.publicKey,
        address: wallet.address.toLowerCase(),
        valid_from: validFrom,
        valid_until: validUntil,
        status,
      },
    ],
  };
}

async function signReceipt(
  template: Record<string, unknown>,
  wallet: Wallet,
  keyId = "receipt-key-1",
  profile = "gossip-eip191-receipt-v1",
): Promise<Record<string, unknown>> {
  const receipt = structuredClone(template.receipt) as Record<string, any>;
  receipt.signing = { profile, key_id: keyId };
  const digest = receiptDigest(receipt);
  const signature = await wallet.signMessage(receiptSigningMessage(digest));
  return {
    receipt,
    receipt_digest: digest,
    signature: Buffer.from(signature.slice(2), "hex").toString("base64url"),
  };
}

function expectInvalid(action: () => unknown): void {
  expectCode(action, "invalid_receipt");
}

function expectCode(action: () => unknown, code: ProtocolError["code"]): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof ProtocolError);
    assert.equal(error.code, code);
    return true;
  });
}

test("verifies the literal EIP-191 receipt vector", () => {
  assert.equal(
    receiptSigningMessage(fixture.receipt.receipt_digest as string),
    fixture.message,
  );
  const verified = verifySignedReceipt(fixture.receipt, fixture.manifest);
  assert.equal(
    verified.signer.address,
    "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
  );
  assert.equal(verified.signer.key_id, "receipt-key-1");
});

test("binds authentic receipts to the exact consultation", async () => {
  const evidenceFixture = JSON.parse(
    fs.readFileSync(
      new URL("./fixtures/v2-evidence-receipts.json", import.meta.url),
      "utf8",
    ),
  ) as { objects: Record<string, Record<string, unknown>> };
  const consultation = evidenceFixture.objects.consultation!;
  const signed = await signReceipt(
    evidenceFixture.objects.acknowledgment!,
    keyOne,
  );
  const manifest = manifestFor(keyOne);

  assert.doesNotThrow(() =>
    verifyConsultationReceiptAuthenticity(signed, manifest, consultation),
  );

  const different = structuredClone(consultation);
  different.operation_id = "different-operation";
  expectInvalid(() =>
    verifyConsultationReceiptAuthenticity(signed, manifest, different),
  );
});

test("rejects payload, signature, binding, and manifest tampering", async () => {
  const valid = await signReceipt(fixture.receipt, keyOne);
  const manifest = manifestFor(keyOne);

  const payloadTampered = structuredClone(valid);
  (payloadTampered.receipt as Record<string, unknown>).server = {
    id: "other-server",
    revision: "synthetic-v1",
  };
  expectCode(
    () => verifySignedReceipt(payloadTampered, manifest),
    "digest_mismatch",
  );

  const digestTampered = structuredClone(valid);
  digestTampered.receipt_digest = `sha256:${"0".repeat(64)}`;
  expectCode(
    () => verifySignedReceipt(digestTampered, manifest),
    "digest_mismatch",
  );

  const signatureTampered = structuredClone(valid);
  const signatureBytes = Buffer.from(
    signatureTampered.signature as string,
    "base64url",
  );
  signatureBytes[0] ^= 1;
  signatureTampered.signature = signatureBytes.toString("base64url");
  expectInvalid(() => verifySignedReceipt(signatureTampered, manifest));

  const serverTampered = await signReceipt(
    { receipt: { ...(valid.receipt as Record<string, unknown>) } },
    keyOne,
  );
  (serverTampered.receipt as Record<string, any>).server.id = "other-server";
  serverTampered.receipt_digest = receiptDigest(serverTampered.receipt);
  expectInvalid(() => verifySignedReceipt(serverTampered, manifest));

  const profileTampered = await signReceipt(
    fixture.receipt,
    keyOne,
    "receipt-key-1",
    "other-profile",
  );
  expectInvalid(() => verifySignedReceipt(profileTampered, manifest));

  const unknownKey = await signReceipt(fixture.receipt, keyOne, "unknown-key");
  expectInvalid(() => verifySignedReceipt(unknownKey, manifest));

  const mismatchedPublicKey = manifestFor(keyOne);
  (mismatchedPublicKey.keys as Array<Record<string, unknown>>)[0]!.public_key =
    keyTwo.signingKey.publicKey;
  expectInvalid(() => parseReceiptTrustManifest(mismatchedPublicKey));
});

test("enforces key status and issue-time validity", async () => {
  const valid = await signReceipt(fixture.receipt, keyOne);

  expectInvalid(() =>
    verifySignedReceipt(valid, manifestFor(keyOne, "revoked")),
  );
  expectInvalid(() =>
    verifySignedReceipt(
      valid,
      manifestFor(keyOne, "active", 1_800_000_001, 1_800_010_000),
    ),
  );
  expectInvalid(() =>
    verifySignedReceipt(
      valid,
      manifestFor(keyOne, "active", 1_799_980_000, 1_799_999_999),
    ),
  );

  const retired = manifestFor(keyOne, "retired");
  assert.doesNotThrow(() => verifySignedReceipt(valid, retired));
});

test("requires canonical 65-byte low-S signatures and Ethereum recovery bytes", async () => {
  const valid = await signReceipt(fixture.receipt, keyOne);
  const bytes = Buffer.from(valid.signature as string, "base64url");

  const wrongRecovery = structuredClone(valid);
  const wrongRecoveryBytes = Buffer.from(bytes);
  wrongRecoveryBytes[64] = 26;
  wrongRecovery.signature = wrongRecoveryBytes.toString("base64url");
  expectInvalid(() => verifySignedReceipt(wrongRecovery, manifestFor(keyOne)));

  const highS = structuredClone(valid);
  const highSBytes = Buffer.from(bytes);
  const s = BigInt(`0x${highSBytes.subarray(32, 64).toString("hex")}`);
  const order =
    0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  highSBytes.set(
    Buffer.from((order - s).toString(16).padStart(64, "0"), "hex"),
    32,
  );
  highS.signature = highSBytes.toString("base64url");
  expectInvalid(() => verifySignedReceipt(highS, manifestFor(keyOne)));
});

test("pins one key per chain while allowing retired chains and new operations to rotate", async () => {
  const templates = [
    fixture.receipt,
    JSON.parse(
      fs.readFileSync(
        new URL("./fixtures/v2-evidence-receipts.json", import.meta.url),
        "utf8",
      ),
    ).objects.pendingReceipt,
    JSON.parse(
      fs.readFileSync(
        new URL("./fixtures/v2-evidence-receipts.json", import.meta.url),
        "utf8",
      ),
    ).objects.completeReceipt,
  ] as Array<Record<string, unknown>>;
  const oldChain: Array<Record<string, unknown>> = [];
  let previousDigest: string | null = null;
  for (const template of templates) {
    const signed = await signReceipt(template, keyOne);
    const receipt = signed.receipt as Record<string, any>;
    if (previousDigest !== null) {
      receipt.previous_receipt_digest = previousDigest;
      signed.receipt_digest = receiptDigest(receipt);
      const signature = await keyOne.signMessage(
        receiptSigningMessage(signed.receipt_digest as string),
      );
      signed.signature = Buffer.from(signature.slice(2), "hex").toString(
        "base64url",
      );
    }
    previousDigest = signed.receipt_digest as string;
    oldChain.push(signed);
  }

  const rotatedManifest = {
    ...manifestFor(keyOne, "retired", 1_799_990_000, 1_800_003_600),
    keys: [
      ...(manifestFor(keyOne, "retired").keys as unknown[]),
      {
        key_id: "receipt-key-2",
        public_key: keyTwo.signingKey.publicKey,
        address: keyTwo.address.toLowerCase(),
        valid_from: 1_800_000_001,
        valid_until: 1_800_010_000,
        status: "active",
      },
    ],
  };
  assert.equal(
    verifyReceiptTransitionChainAuthenticity(oldChain, rotatedManifest).length,
    3,
  );

  const newOperationTemplate = structuredClone(fixture.receipt);
  (newOperationTemplate.receipt as Record<string, any>).issued_at =
    1_800_000_002;
  (newOperationTemplate.receipt as Record<string, any>).accepted_at =
    1_800_000_002;
  const newOperation = await signReceipt(
    newOperationTemplate,
    keyTwo,
    "receipt-key-2",
  );
  assert.equal(
    verifySignedReceipt(newOperation, rotatedManifest).signer.key_id,
    "receipt-key-2",
  );

  const mixed = [
    oldChain[0]!,
    await signReceipt(templates[1]!, keyTwo, "receipt-key-2"),
  ];
  const mixedReceipt = mixed[1]!.receipt as Record<string, any>;
  mixedReceipt.previous_receipt_digest = mixed[0]!.receipt_digest;
  mixed[1]!.receipt_digest = receiptDigest(mixedReceipt);
  const mixedSignature = await keyTwo.signMessage(
    receiptSigningMessage(mixed[1]!.receipt_digest as string),
  );
  mixed[1]!.signature = Buffer.from(mixedSignature.slice(2), "hex").toString(
    "base64url",
  );
  expectInvalid(() =>
    verifyReceiptTransitionChainAuthenticity(mixed, rotatedManifest),
  );
});
