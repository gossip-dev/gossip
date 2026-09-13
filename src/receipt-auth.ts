import {
  computeAddress,
  hashMessage,
  recoverAddress,
  SigningKey,
} from "ethers";
import { canonicalJson, PROTOCOL_REVISION } from "./canonical.js";
import { MAX_UNIX_SECONDS, protocolIdentifierSchema } from "./protocol-v2.js";
import {
  parseSignedReceipt,
  validateReceiptConsultation,
  validateReceiptTransitionChain,
  type ReceiptPayload,
  type SignedReceipt,
} from "./receipts-v2.js";
import { ProtocolError } from "./protocol-errors.js";

export const RECEIPT_AUTH_PROFILE = "gossip-eip191-receipt-v1" as const;
export const RECEIPT_TRUST_MANIFEST_SCHEMA =
  "gossip.receipt-trust-manifest.v1" as const;

const ADDRESS = /^0x[0-9a-f]{40}$/;
const PUBLIC_KEY = /^0x04[0-9a-f]{128}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const SECP256K1_ORDER =
  0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECP256K1_HALF_ORDER = SECP256K1_ORDER / 2n;

export type ReceiptKeyStatus = "active" | "retired" | "revoked";

export type ReceiptTrustKey = {
  key_id: string;
  public_key: string;
  address: string;
  valid_from: number;
  valid_until: number;
  status: ReceiptKeyStatus;
};

export type ReceiptTrustManifest = {
  schema: typeof RECEIPT_TRUST_MANIFEST_SCHEMA;
  server_id: string;
  profile: typeof RECEIPT_AUTH_PROFILE;
  keys: ReceiptTrustKey[];
};

export type VerifiedReceipt = SignedReceipt & {
  signer: {
    server_id: string;
    profile: typeof RECEIPT_AUTH_PROFILE;
    key_id: string;
    public_key: string;
    address: string;
  };
};

export type ReceiptSignatureEnvelope = {
  receipt: Pick<
    ReceiptPayload,
    "auth_profile" | "server" | "signing" | "issued_at"
  >;
  receipt_digest: string;
  signature: string;
};

export type ReceiptSigner = {
  server_id: string;
  profile: typeof RECEIPT_AUTH_PROFILE;
  key_id: string;
  public_key: string;
  address: string;
};

function invalid(): never {
  throw new ProtocolError("invalid_receipt");
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid();
  }

  return value as Record<string, unknown>;
}

function exactObject(
  value: unknown,
  required: readonly string[],
  allowed: readonly string[] = required,
): Record<string, unknown> {
  const result = object(value);

  if (
    Object.keys(result).some((key) => !allowed.includes(key)) ||
    required.some((key) => !(key in result))
  ) {
    invalid();
  }

  return result;
}

function identifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    !protocolIdentifierSchema.safeParse(value).success
  ) {
    invalid();
  }

  return value;
}

function unixTime(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_UNIX_SECONDS
  ) {
    invalid();
  }

  return value;
}

function parseManifest(input: unknown): ReceiptTrustManifest {
  canonicalJson(input);
  const manifest = exactObject(input, [
    "schema",
    "server_id",
    "profile",
    "keys",
  ]);

  if (
    manifest.schema !== RECEIPT_TRUST_MANIFEST_SCHEMA ||
    manifest.profile !== RECEIPT_AUTH_PROFILE
  ) {
    invalid();
  }

  const serverId = identifier(manifest.server_id);
  if (
    !Array.isArray(manifest.keys) ||
    manifest.keys.length === 0 ||
    manifest.keys.length > 16
  ) {
    invalid();
  }

  const keyIds = new Set<string>();
  const keys = manifest.keys.map((inputKey) => {
    const key = exactObject(inputKey, [
      "key_id",
      "public_key",
      "address",
      "valid_from",
      "valid_until",
      "status",
    ]);
    const keyId = identifier(key.key_id);
    if (keyIds.has(keyId)) {
      invalid();
    }
    keyIds.add(keyId);

    if (
      typeof key.public_key !== "string" ||
      !PUBLIC_KEY.test(key.public_key)
    ) {
      invalid();
    }
    if (typeof key.address !== "string" || !ADDRESS.test(key.address)) {
      invalid();
    }

    const validFrom = unixTime(key.valid_from);
    const validUntil = unixTime(key.valid_until);
    if (validUntil <= validFrom) {
      invalid();
    }
    if (
      key.status !== "active" &&
      key.status !== "retired" &&
      key.status !== "revoked"
    ) {
      invalid();
    }

    try {
      if (computeAddress(key.public_key).toLowerCase() !== key.address) {
        invalid();
      }
    } catch {
      invalid();
    }

    return {
      key_id: keyId,
      public_key: key.public_key,
      address: key.address,
      valid_from: validFrom,
      valid_until: validUntil,
      status: key.status as ReceiptKeyStatus,
    };
  });

  return {
    schema: RECEIPT_TRUST_MANIFEST_SCHEMA,
    server_id: serverId,
    profile: RECEIPT_AUTH_PROFILE,
    keys,
  };
}

function signatureBytes(signature: string): Uint8Array {
  if (!BASE64URL.test(signature)) {
    invalid();
  }

  let bytes: Uint8Array;
  try {
    bytes = Buffer.from(signature, "base64url");
  } catch {
    invalid();
  }

  if (
    bytes.length !== 65 ||
    Buffer.from(bytes).toString("base64url") !== signature
  ) {
    invalid();
  }

  const recovery = bytes[64];
  if (recovery !== 27 && recovery !== 28) {
    invalid();
  }

  const r = BigInt(`0x${Buffer.from(bytes.subarray(0, 32)).toString("hex")}`);
  const s = BigInt(`0x${Buffer.from(bytes.subarray(32, 64)).toString("hex")}`);
  if (r <= 0n || r >= SECP256K1_ORDER || s <= 0n || s > SECP256K1_HALF_ORDER) {
    invalid();
  }

  return bytes;
}

function receiptMessage(receiptDigest: string): string {
  if (!DIGEST.test(receiptDigest)) {
    invalid();
  }

  return `Gossip receipt v1\n${PROTOCOL_REVISION}\n${receiptDigest}`;
}

function verifySignature(
  parsed: ReceiptSignatureEnvelope,
  manifest: ReceiptTrustManifest,
): ReceiptSigner {
  const receipt = parsed.receipt;
  const signing = receipt.signing;
  if (
    receipt.auth_profile !== "gossip-eip191-v2" ||
    signing.profile !== manifest.profile ||
    receipt.server.id !== manifest.server_id
  ) {
    invalid();
  }

  const key = manifest.keys.find(
    (candidate) => candidate.key_id === signing.key_id,
  );
  if (!key || key.status === "revoked") {
    invalid();
  }
  if (
    receipt.issued_at < key.valid_from ||
    receipt.issued_at >= key.valid_until
  ) {
    invalid();
  }

  const bytes = signatureBytes(parsed.signature);
  const signature = `0x${Buffer.from(bytes).toString("hex")}`;
  const digest = hashMessage(receiptMessage(parsed.receipt_digest));
  let recoveredAddress: string;
  let recoveredPublicKey: string;
  try {
    recoveredAddress = recoverAddress(digest, signature);
    recoveredPublicKey = SigningKey.recoverPublicKey(digest, signature);
  } catch {
    invalid();
  }

  if (
    recoveredAddress.toLowerCase() !== key.address ||
    recoveredPublicKey.toLowerCase() !== key.public_key
  ) {
    invalid();
  }

  return {
    server_id: manifest.server_id,
    profile: manifest.profile,
    key_id: key.key_id,
    public_key: key.public_key,
    address: key.address,
  };
}

function verifyOne(
  parsed: SignedReceipt,
  manifest: ReceiptTrustManifest,
): VerifiedReceipt {
  return {
    ...parsed,
    signer: verifySignature(parsed, manifest),
  };
}

export function parseReceiptTrustManifest(
  input: unknown,
): ReceiptTrustManifest {
  return parseManifest(input);
}

export function receiptSigningMessage(receiptDigest: string): string {
  return receiptMessage(receiptDigest);
}

export function verifyReceiptSignature(
  input: ReceiptSignatureEnvelope,
  trustManifest: unknown,
): ReceiptSigner {
  const manifest = parseManifest(trustManifest);
  return verifySignature(input, manifest);
}

export function verifySignedReceipt(
  input: unknown,
  trustManifest: unknown,
): VerifiedReceipt {
  const manifest = parseManifest(trustManifest);
  return verifyOne(parseSignedReceipt(input), manifest);
}

export function verifyReceiptTransitionChainAuthenticity(
  input: unknown,
  trustManifest: unknown,
): VerifiedReceipt[] {
  const manifest = parseManifest(trustManifest);
  return verifyChain(input, manifest);
}

export function verifyConsultationReceiptAuthenticity(
  input: unknown,
  trustManifest: unknown,
  consultation: unknown,
): VerifiedReceipt {
  const manifest = parseManifest(trustManifest);
  return verifyOne(validateReceiptConsultation(input, consultation), manifest);
}

export function verifyConsultationReceiptChainAuthenticity(
  input: unknown,
  trustManifest: unknown,
  consultation: unknown,
): VerifiedReceipt[] {
  const manifest = parseManifest(trustManifest);
  return verifyChain(input, manifest, consultation);
}

function verifyChain(
  input: unknown,
  manifest: ReceiptTrustManifest,
  consultation?: unknown,
): VerifiedReceipt[] {
  const receipts = validateReceiptTransitionChain(input, consultation).map(
    (value) => verifyOne(value, manifest),
  );
  const first = receipts[0];
  if (!first) {
    invalid();
  }

  for (const receipt of receipts) {
    if (receipt.signer.key_id !== first.signer.key_id) {
      invalid();
    }
  }

  return receipts;
}

export const verifyReceiptAuthenticity = verifySignedReceipt;
export const validateReceiptAuthenticity = verifySignedReceipt;
export const verifyReceiptChainAuthenticity =
  verifyReceiptTransitionChainAuthenticity;
