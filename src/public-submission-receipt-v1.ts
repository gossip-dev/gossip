import { canonicalDigest, canonicalJson } from "./canonical.js";
import {
  RECEIPT_AUTH_PROFILE,
  verifyReceiptSignature,
  type ReceiptSigner,
  type ReceiptSignatureEnvelope,
} from "./receipt-auth.js";
import { ProtocolError } from "./protocol-errors.js";
import {
  parsePublicSubmission,
  publicSubmissionDigest,
} from "./public-submission-v1.js";
import {
  actorSchema,
  AUTH_PROFILE,
  canonicalHttpsUrlSchema,
  MAX_UNIX_SECONDS,
  operationIdV2Schema,
  PROTOCOL_REVISION,
  protocolIdentifierSchema,
} from "./protocol-v2.js";
import { resultDigest } from "./evidence-v2.js";

export const PUBLIC_SUBMISSION_RECEIPT_SCHEMA =
  "gossip.public-submission-receipt.v1" as const;
export const PUBLIC_SUBMISSION_RECEIPT_SCHEMA_REVISION = "2026-09-11" as const;
export const PUBLIC_SUBMISSION_RECEIPT_KIND = "public_submission" as const;

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
type Dict = Record<string, unknown>;

export type PublicSubmissionReceipt = {
  protocol: typeof PROTOCOL_REVISION;
  schema_revision: typeof PUBLIC_SUBMISSION_RECEIPT_SCHEMA_REVISION;
  schema: typeof PUBLIC_SUBMISSION_RECEIPT_SCHEMA;
  auth_profile: typeof AUTH_PROFILE;
  operation_kind: typeof PUBLIC_SUBMISSION_RECEIPT_KIND;
  operation_id: string;
  request_digest: string;
  actor: { chain_id: string; address: string };
  owner: { chain_id: string; address: string };
  endpoint: string;
  audience: string;
  server: { id: string; revision: string };
  signing: { profile: typeof RECEIPT_AUTH_PROFILE; key_id: string };
  issued_at: number;
  status: "complete";
  max_cost: { unit: "earned_credit"; amount: "0" };
  economics: {
    unit: "earned_credit";
    state: "settled";
    reserved_amount: "0";
    charged_amount: "0";
  };
  result_digest: string;
  evidence_digests: string[];
};

export type SignedPublicSubmissionReceipt = {
  receipt: PublicSubmissionReceipt;
  receipt_digest: string;
  signature: string;
};

export type VerifiedPublicSubmissionReceipt = SignedPublicSubmissionReceipt & {
  signer: ReceiptSigner;
};

function invalid(): never {
  throw new ProtocolError("invalid_receipt");
}

function object(value: unknown): Dict {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid();
  }

  return value as Dict;
}

function exactObject(value: unknown, fields: readonly string[]): Dict {
  const result = object(value);
  const keys = Object.keys(result);

  if (
    keys.length !== fields.length ||
    keys.some((key) => !fields.includes(key)) ||
    fields.some((field) => !(field in result))
  ) {
    invalid();
  }

  return result;
}

function text(value: unknown, pattern = /[\s\S]/u): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    invalid();
  }

  return value;
}

function timestamp(value: unknown): number {
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

function digest(value: unknown): string {
  return text(value, DIGEST);
}

function actor(value: unknown): { chain_id: string; address: string } {
  const parsed = actorSchema.safeParse(value);
  if (!parsed.success) {
    invalid();
  }

  return parsed.data;
}

function url(value: unknown): string {
  const result = text(value);
  if (!canonicalHttpsUrlSchema.safeParse(result).success) {
    invalid();
  }

  return result;
}

function parseEvidenceDigests(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    invalid();
  }

  const result = value.map(digest);
  if (
    new Set(result).size !== result.length ||
    result.some((item, index) => index > 0 && result[index - 1]! >= item)
  ) {
    invalid();
  }

  return result;
}

function parseReceipt(input: unknown): PublicSubmissionReceipt {
  canonicalJson(input);
  const result = exactObject(input, [
    "protocol",
    "schema_revision",
    "schema",
    "auth_profile",
    "operation_kind",
    "operation_id",
    "request_digest",
    "actor",
    "owner",
    "endpoint",
    "audience",
    "server",
    "signing",
    "issued_at",
    "status",
    "max_cost",
    "economics",
    "result_digest",
    "evidence_digests",
  ]);

  if (
    result.protocol !== PROTOCOL_REVISION ||
    result.schema_revision !== PUBLIC_SUBMISSION_RECEIPT_SCHEMA_REVISION ||
    result.schema !== PUBLIC_SUBMISSION_RECEIPT_SCHEMA ||
    result.auth_profile !== AUTH_PROFILE ||
    result.operation_kind !== PUBLIC_SUBMISSION_RECEIPT_KIND ||
    result.status !== "complete"
  ) {
    invalid();
  }

  const operationId = operationIdV2Schema.safeParse(result.operation_id);
  if (!operationId.success) {
    invalid();
  }

  const receiptActor = actor(result.actor);
  const owner = actor(result.owner);
  if (canonicalJson(receiptActor) !== canonicalJson(owner)) {
    invalid();
  }

  const endpoint = url(result.endpoint);
  const audience = url(result.audience);
  const server = exactObject(result.server, ["id", "revision"]);
  const serverId = protocolIdentifierSchema.safeParse(server.id);
  const serverRevision = protocolIdentifierSchema.safeParse(server.revision);
  if (!serverId.success || !serverRevision.success) {
    invalid();
  }

  const signing = exactObject(result.signing, ["profile", "key_id"]);
  if (
    signing.profile !== RECEIPT_AUTH_PROFILE ||
    !protocolIdentifierSchema.safeParse(signing.key_id).success
  ) {
    invalid();
  }

  const maxCost = exactObject(result.max_cost, ["unit", "amount"]);
  if (maxCost.unit !== "earned_credit" || maxCost.amount !== "0") {
    invalid();
  }

  const economics = exactObject(result.economics, [
    "unit",
    "state",
    "reserved_amount",
    "charged_amount",
  ]);
  if (
    economics.unit !== "earned_credit" ||
    economics.state !== "settled" ||
    economics.reserved_amount !== "0" ||
    economics.charged_amount !== "0"
  ) {
    invalid();
  }

  return {
    protocol: PROTOCOL_REVISION,
    schema_revision: PUBLIC_SUBMISSION_RECEIPT_SCHEMA_REVISION,
    schema: PUBLIC_SUBMISSION_RECEIPT_SCHEMA,
    auth_profile: AUTH_PROFILE,
    operation_kind: PUBLIC_SUBMISSION_RECEIPT_KIND,
    operation_id: operationId.data,
    request_digest: digest(result.request_digest),
    actor: receiptActor,
    owner,
    endpoint,
    audience,
    server: { id: serverId.data, revision: serverRevision.data },
    signing: {
      profile: RECEIPT_AUTH_PROFILE,
      key_id: signing.key_id as string,
    },
    issued_at: timestamp(result.issued_at),
    status: "complete",
    max_cost: { unit: "earned_credit", amount: "0" },
    economics: {
      unit: "earned_credit",
      state: "settled",
      reserved_amount: "0",
      charged_amount: "0",
    },
    result_digest: digest(result.result_digest),
    evidence_digests: parseEvidenceDigests(result.evidence_digests),
  };
}

function parseSignature(value: unknown): string {
  const signature = text(value, BASE64URL);
  if (signature.length > 1024) {
    invalid();
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(signature, "base64url");
  } catch {
    invalid();
  }

  if (
    bytes.length !== 65 ||
    bytes.toString("base64url") !== signature ||
    (bytes[64] !== 27 && bytes[64] !== 28)
  ) {
    invalid();
  }

  return signature;
}

export function parseSignedPublicSubmissionReceipt(
  input: unknown,
): SignedPublicSubmissionReceipt {
  canonicalJson(input);
  const envelope = exactObject(input, [
    "receipt",
    "receipt_digest",
    "signature",
  ]);
  const receipt = parseReceipt(envelope.receipt);
  const receiptDigest = digest(envelope.receipt_digest);
  const signature = parseSignature(envelope.signature);

  if (canonicalDigest("receipt", receipt) !== receiptDigest) {
    throw new ProtocolError("digest_mismatch");
  }

  return { receipt, receipt_digest: receiptDigest, signature };
}

export function publicSubmissionReceiptDigest(input: unknown): string {
  return canonicalDigest("receipt", parseReceipt(input));
}

export function verifyPublicSubmissionReceipt(
  input: unknown,
  trustManifest: unknown,
): VerifiedPublicSubmissionReceipt {
  const parsed = parseSignedPublicSubmissionReceipt(input);
  const signer = verifyReceiptSignature(
    parsed as ReceiptSignatureEnvelope,
    trustManifest,
  );

  return { ...parsed, signer };
}

export function validatePublicSubmissionReceipt(
  receiptInput: unknown,
  submissionInput: unknown,
): SignedPublicSubmissionReceipt {
  const receipt = parseSignedPublicSubmissionReceipt(receiptInput);
  const submission = parsePublicSubmission(submissionInput);
  const payload = receipt.receipt;

  if (
    payload.operation_id !== submission.operation_id ||
    payload.request_digest !== publicSubmissionDigest(submission) ||
    canonicalJson(payload.actor) !== canonicalJson(submission.actor) ||
    payload.endpoint !== submission.endpoint ||
    payload.audience !== submission.audience ||
    payload.result_digest !== resultDigest(submission.result) ||
    canonicalJson(payload.evidence_digests) !==
      canonicalJson(submission.evidence.roots)
  ) {
    invalid();
  }

  return receipt;
}

export const parsePublicSubmissionReceipt = parseSignedPublicSubmissionReceipt;
