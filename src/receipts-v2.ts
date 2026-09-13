import { canonicalDigest, canonicalJson } from "./canonical.js";
import {
  AUTH_PROFILE,
  PROTOCOL_REVISION,
  SCHEMA_REVISION,
  actorSchema,
  canonicalHttpsUrlSchema,
  consultationSchema,
  maxCostSchema,
  operationIdV2Schema,
  protocolIdentifierSchema,
  qualitySchema,
} from "./protocol-v2.js";
import { ProtocolError, type ProtocolErrorCode } from "./protocol-errors.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SIGNATURE = /^[A-Za-z0-9_-]+$/;
const UINT = /^(?:0|[1-9][0-9]*)$/;
const MAX_TIME = 253402300799;
const ERROR_CODES = new Set<ProtocolErrorCode>([
  "invalid_request",
  "invalid_canonical_json",
  "limit_exceeded",
  "unsupported_version",
  "unsupported_auth_profile",
  "unsupported_capability",
  "expired_deadline",
  "capability_mismatch",
  "expired_capabilities",
  "unauthorized",
  "operation_conflict",
  "operation_not_found",
  "reconciliation_required",
  "unsupported_tier",
  "maximum_cost_exceeded",
  "insufficient_credit",
  "freshness_unmet",
  "finality_unmet",
  "evidence_unavailable",
  "invalid_evidence",
  "invalid_receipt",
  "digest_mismatch",
  "invalid_lineage",
  "operation_failed",
]);
type Dict = Record<string, unknown>;
export type ReceiptActor = { chain_id: string; address: string };
export type ReceiptQuality = {
  requested: {
    tier: "standard" | "enriched";
    max_age_seconds: number;
    finality: "latest" | "safe" | "finalized";
    allow_partial: boolean;
  };
  selected_tier: "standard" | "enriched";
  unmet_requirements: Array<"freshness" | "finality" | "evidence">;
};
export type ReceiptPayload = {
  protocol: typeof PROTOCOL_REVISION;
  schema_revision: typeof SCHEMA_REVISION;
  schema: "gossip.receipt.v2";
  auth_profile: typeof AUTH_PROFILE;
  kind: "acknowledgment" | "state";
  operation_id: string;
  request_digest: string;
  actor: ReceiptActor;
  owner: ReceiptActor;
  endpoint: string;
  audience: string;
  server: { id: string; revision: string };
  signing: { profile: string; key_id: string };
  sequence: number;
  previous_receipt_digest: string | null;
  accepted_at: number;
  issued_at: number;
  status:
    | "pending"
    | "complete"
    | "partial"
    | "rejected"
    | "reconciliation_required";
  quality: ReceiptQuality;
  max_cost: { unit: "earned_credit"; amount: string };
  economics: {
    unit: "earned_credit";
    state: "reserved" | "settled" | "released" | "unknown";
    reserved_amount: string;
    charged_amount: string | null;
  };
  result_digest: string | null;
  error_code: ProtocolErrorCode | null;
};
export type SignedReceipt = {
  receipt: ReceiptPayload;
  receipt_digest: string;
  signature: string;
};

function fail(
  code:
    | "invalid_receipt"
    | "digest_mismatch"
    | "operation_failed"
    | "limit_exceeded",
): never {
  throw new ProtocolError(code);
}
function dict(value: unknown): Dict {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail("invalid_receipt");
  return value as Dict;
}
function strict(
  value: unknown,
  required: readonly string[],
  allowed: readonly string[],
): Dict {
  const result = dict(value);
  if (
    Object.keys(result).some((key) => !allowed.includes(key)) ||
    required.some((key) => !(key in result))
  )
    fail("invalid_receipt");
  return result;
}
function text(value: unknown, pattern = /[\s\S]/u): string {
  if (typeof value !== "string" || !pattern.test(value))
    fail("invalid_receipt");
  return value;
}
function time(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_TIME
  )
    fail("invalid_receipt");
  return value;
}
function amount(value: unknown, nullable = false): string | null {
  if (nullable && value === null) return null;
  if (
    typeof value !== "string" ||
    !UINT.test(value) ||
    value.length > 78 ||
    BigInt(value) > (1n << 256n) - 1n
  )
    fail("invalid_receipt");
  return value;
}
function actor(value: unknown): ReceiptActor {
  const parsed = actorSchema.safeParse(value);
  if (!parsed.success) {
    fail("invalid_receipt");
  }
  return parsed.data;
}

function payload(input: unknown): ReceiptPayload {
  canonicalJson(input);
  const result = strict(
    input,
    [
      "protocol",
      "schema_revision",
      "schema",
      "auth_profile",
      "kind",
      "operation_id",
      "request_digest",
      "actor",
      "owner",
      "endpoint",
      "audience",
      "server",
      "signing",
      "sequence",
      "previous_receipt_digest",
      "accepted_at",
      "issued_at",
      "status",
      "quality",
      "max_cost",
      "economics",
      "result_digest",
      "error_code",
    ],
    [
      "protocol",
      "schema_revision",
      "schema",
      "auth_profile",
      "kind",
      "operation_id",
      "request_digest",
      "actor",
      "owner",
      "endpoint",
      "audience",
      "server",
      "signing",
      "sequence",
      "previous_receipt_digest",
      "accepted_at",
      "issued_at",
      "status",
      "quality",
      "max_cost",
      "economics",
      "result_digest",
      "error_code",
    ],
  );
  if (
    result.protocol !== PROTOCOL_REVISION ||
    result.schema_revision !== SCHEMA_REVISION ||
    result.schema !== "gossip.receipt.v2" ||
    result.auth_profile !== AUTH_PROFILE
  )
    fail("invalid_receipt");
  if (result.kind !== "acknowledgment" && result.kind !== "state")
    fail("invalid_receipt");
  if (!operationIdV2Schema.safeParse(result.operation_id).success) {
    fail("invalid_receipt");
  }
  text(result.request_digest, DIGEST);
  const receiptActor = actor(result.actor);
  const owner = actor(result.owner);
  if (canonicalJson(receiptActor) !== canonicalJson(owner))
    fail("invalid_receipt");
  for (const key of ["endpoint", "audience"]) {
    const value = text(result[key]);
    if (!canonicalHttpsUrlSchema.safeParse(value).success)
      fail("invalid_receipt");
  }
  const server = strict(result.server, ["id", "revision"], ["id", "revision"]);
  if (
    !protocolIdentifierSchema.safeParse(server.id).success ||
    !protocolIdentifierSchema.safeParse(server.revision).success
  ) {
    fail("invalid_receipt");
  }
  const signing = strict(
    result.signing,
    ["profile", "key_id"],
    ["profile", "key_id"],
  );
  if (
    !protocolIdentifierSchema.safeParse(signing.profile).success ||
    !protocolIdentifierSchema.safeParse(signing.key_id).success
  ) {
    fail("invalid_receipt");
  }
  if (
    typeof result.sequence !== "number" ||
    !Number.isSafeInteger(result.sequence) ||
    result.sequence < 0 ||
    result.sequence > 0xffffffff
  )
    fail("invalid_receipt");
  if (result.previous_receipt_digest !== null)
    text(result.previous_receipt_digest, DIGEST);
  const accepted = time(result.accepted_at);
  const issued = time(result.issued_at);
  if (accepted > issued) fail("invalid_receipt");
  if (
    result.kind === "acknowledgment" &&
    (result.sequence !== 0 ||
      result.previous_receipt_digest !== null ||
      result.status !== "pending")
  )
    fail("invalid_receipt");
  if (
    result.kind === "state" &&
    (result.sequence < 1 || result.previous_receipt_digest === null)
  )
    fail("invalid_receipt");
  const quality = strict(
    result.quality,
    ["requested", "selected_tier", "unmet_requirements"],
    ["requested", "selected_tier", "unmet_requirements"],
  );
  const requestedResult = qualitySchema.safeParse(quality.requested);
  if (
    !requestedResult.success ||
    quality.selected_tier !== requestedResult.data.tier
  )
    fail("invalid_receipt");
  const requested = requestedResult.data;
  const unmet = array(quality.unmet_requirements, 3).map((item) =>
    text(item, /^(freshness|finality|evidence)$/),
  ) as ReceiptQuality["unmet_requirements"];
  if (new Set(unmet).size !== unmet.length) fail("invalid_receipt");
  const maxCostResult = maxCostSchema.safeParse(result.max_cost);
  if (!maxCostResult.success) {
    fail("invalid_receipt");
  }
  const maxCost = maxCostResult.data;
  const ceiling = maxCost.amount;
  const economics = strict(
    result.economics,
    ["unit", "state", "reserved_amount", "charged_amount"],
    ["unit", "state", "reserved_amount", "charged_amount"],
  );
  if (
    economics.unit !== "earned_credit" ||
    typeof economics.state !== "string" ||
    !["reserved", "settled", "released", "unknown"].includes(economics.state)
  )
    fail("invalid_receipt");
  const reserved = amount(economics.reserved_amount)!;
  const charged = amount(economics.charged_amount, true);
  if (
    BigInt(reserved) > BigInt(ceiling) ||
    (charged !== null && BigInt(charged) > BigInt(reserved))
  )
    fail("invalid_receipt");
  if (
    requested.tier === "standard" &&
    (ceiling !== "0" ||
      reserved !== "0" ||
      (charged !== null && charged !== "0"))
  )
    fail("invalid_receipt");
  const statuses = [
    "pending",
    "complete",
    "partial",
    "rejected",
    "reconciliation_required",
  ];
  if (typeof result.status !== "string" || !statuses.includes(result.status)) {
    fail("invalid_receipt");
  }
  const terminal =
    result.status === "complete" ||
    result.status === "partial" ||
    result.status === "rejected";
  if (
    (result.status === "complete" || result.status === "partial") &&
    (typeof result.result_digest !== "string" ||
      !DIGEST.test(result.result_digest) ||
      result.error_code !== null)
  )
    fail("invalid_receipt");
  if (
    (result.status === "rejected" ||
      result.status === "reconciliation_required") &&
    (typeof result.error_code !== "string" ||
      !ERROR_CODES.has(result.error_code as ProtocolErrorCode) ||
      result.result_digest !== null)
  )
    fail("invalid_receipt");
  if (
    result.status === "rejected" &&
    ![
      "unauthorized",
      "freshness_unmet",
      "finality_unmet",
      "evidence_unavailable",
      "operation_failed",
    ].includes(result.error_code as string)
  )
    fail("invalid_receipt");
  if (
    result.status === "reconciliation_required" &&
    result.error_code !== "reconciliation_required"
  )
    fail("invalid_receipt");
  if (!terminal && result.result_digest !== null) fail("invalid_receipt");
  if (result.status === "pending" && result.error_code !== null)
    fail("invalid_receipt");
  if (result.status === "pending" && economics.state !== "reserved")
    fail("invalid_receipt");
  if (
    result.status === "pending" &&
    (charged !== null || result.result_digest !== null || unmet.length !== 0)
  )
    fail("invalid_receipt");
  if (
    result.kind === "acknowledgment" &&
    (result.result_digest !== null ||
      result.error_code !== null ||
      charged !== null ||
      economics.state !== "reserved")
  )
    fail("invalid_receipt");
  if (
    result.status === "reconciliation_required" &&
    economics.state !== "unknown"
  )
    fail("invalid_receipt");
  if (result.status === "reconciliation_required" && charged !== null)
    fail("invalid_receipt");
  if (result.status === "rejected" && economics.state !== "released")
    fail("invalid_receipt");
  if (result.status === "rejected" && charged !== "0") fail("invalid_receipt");
  if (result.status === "rejected" && unmet.length !== 0)
    fail("invalid_receipt");
  if (
    (result.status === "complete" || result.status === "partial") &&
    economics.state !== "settled"
  )
    fail("invalid_receipt");
  if (
    (result.status === "complete" || result.status === "partial") &&
    charged === null
  )
    fail("invalid_receipt");
  if (
    result.status === "complete" &&
    (quality.unmet_requirements as unknown[]).length !== 0
  )
    fail("invalid_receipt");
  if (
    result.status === "partial" &&
    (quality.unmet_requirements as unknown[]).length === 0
  )
    fail("invalid_receipt");
  if (result.status === "partial" && requested.allow_partial !== true)
    fail("invalid_receipt");
  return {
    ...result,
    actor: receiptActor,
    owner,
    max_cost: { ...maxCost, amount: ceiling },
    economics: {
      ...economics,
      reserved_amount: reserved,
      charged_amount: charged,
    },
    quality: { ...quality, requested, unmet_requirements: unmet },
  } as ReceiptPayload;
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value)) fail("invalid_receipt");
  if (value.length > max) fail("limit_exceeded");
  return value;
}

export function parseSignedReceipt(input: unknown): SignedReceipt {
  canonicalJson(input);
  const result = strict(
    input,
    ["receipt", "receipt_digest", "signature"],
    ["receipt", "receipt_digest", "signature"],
  );
  const receipt = payload(result.receipt);
  const digest = text(result.receipt_digest, DIGEST);
  const signature = text(result.signature, SIGNATURE);
  if (signature.length > 1024) fail("invalid_receipt");
  try {
    const decoded = Buffer.from(signature, "base64url");
    if (decoded.length === 0 || decoded.toString("base64url") !== signature)
      fail("invalid_receipt");
  } catch {
    fail("invalid_receipt");
  }
  if (canonicalDigest("receipt", receipt) !== digest) fail("digest_mismatch");
  return {
    receipt,
    receipt_digest: digest,
    signature,
  };
}
export function receiptDigest(input: unknown): string {
  return canonicalDigest("receipt", payload(input));
}

export function validateReceiptConsultation(
  input: unknown,
  consultationInput: unknown,
  _now?: number,
): SignedReceipt {
  const parsed = parseSignedReceipt(input);
  canonicalJson(consultationInput);
  const consultation = consultationSchema.safeParse(consultationInput);
  if (!consultation.success) {
    fail("invalid_receipt");
  }
  const request = consultation.data;
  if (
    parsed.receipt.request_digest !== canonicalDigest("request", request) ||
    parsed.receipt.operation_id !== request.operation_id ||
    canonicalJson(parsed.receipt.actor) !== canonicalJson(request.actor) ||
    parsed.receipt.endpoint !== request.endpoint ||
    parsed.receipt.audience !== request.audience ||
    canonicalJson((parsed.receipt.quality as Dict).requested) !==
      canonicalJson(request.quality) ||
    canonicalJson(parsed.receipt.max_cost) !==
      canonicalJson(request.max_cost) ||
    (parsed.receipt.accepted_at as number) >= request.deadline
  ) {
    fail("invalid_receipt");
  }
  return parsed;
}

export function validateReceiptTransitionChain(
  input: unknown,
  consultationInput?: unknown,
  now = 0,
): SignedReceipt[] {
  canonicalJson(input);
  const values = array(input, 256);
  if (values.length < 1) fail("invalid_receipt");
  const receipts = values.map(parseSignedReceipt);
  if (consultationInput !== undefined)
    validateReceiptConsultation(values[0], consultationInput, now);
  const first = receipts[0]!.receipt;
  if (first.kind !== "acknowledgment") fail("invalid_receipt");
  const immutable = (item: Dict) =>
    canonicalJson({
      protocol: item.protocol,
      schema_revision: item.schema_revision,
      schema: item.schema,
      auth_profile: item.auth_profile,
      operation_id: item.operation_id,
      request_digest: item.request_digest,
      actor: item.actor,
      owner: item.owner,
      endpoint: item.endpoint,
      audience: item.audience,
      server_id: (item.server as Dict).id,
      signing: item.signing,
      accepted_at: item.accepted_at,
      requested_quality: (item.quality as Dict).requested,
      selected_tier: (item.quality as Dict).selected_tier,
      max_cost: item.max_cost,
      reserved_amount: (item.economics as Dict).reserved_amount,
    });

  for (let index = 0; index < receipts.length; index++) {
    const current = receipts[index]!;
    if (index === 0) {
      continue;
    }

    const previous = receipts[index - 1]!;
    const previousStatus = previous.receipt.status;
    const exactReplay = current.receipt_digest === previous.receipt_digest;
    const exactEnvelopeReplay =
      exactReplay && canonicalJson(current) === canonicalJson(previous);
    const previousTerminal = ["complete", "partial", "rejected"].includes(
      String(previousStatus),
    );

    if (previousTerminal) {
      if (!exactEnvelopeReplay) {
        fail("invalid_receipt");
      }
      continue;
    }
    if (exactReplay) {
      fail("invalid_receipt");
    }

    if (
      current.receipt.kind !== "state" ||
      current.receipt.sequence !== (previous.receipt.sequence as number) + 1 ||
      current.receipt.previous_receipt_digest !== previous.receipt_digest ||
      (current.receipt.issued_at as number) <
        (previous.receipt.issued_at as number) ||
      immutable(current.receipt) !== immutable(first)
    ) {
      fail("invalid_receipt");
    }

    if (
      previousStatus === "reconciliation_required" &&
      !["reconciliation_required", "complete", "partial", "rejected"].includes(
        String(current.receipt.status),
      )
    ) {
      fail("invalid_receipt");
    }
  }
  return receipts;
}
export const parseReceipt = parseSignedReceipt;
export const validateReceiptChain = validateReceiptTransitionChain;
