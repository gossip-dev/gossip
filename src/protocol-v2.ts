import { z } from "zod";
import {
  CANONICAL_LIMITS,
  canonicalDigest,
  canonicalJson,
  PROTOCOL_REVISION,
} from "./canonical.js";
import { ProtocolError } from "./protocol-errors.js";

export { CANONICAL_LIMITS, PROTOCOL_REVISION } from "./canonical.js";

export const SCHEMA_REVISION = "2026-09-09" as const;
export const AUTH_PROFILE = "gossip-eip191-v2" as const;
export const MCP_REVISION = "2025-11-25" as const;

export const MAX_UNIX_SECONDS = 253_402_300_799;
const UINT256_MAX = (1n << 256n) - 1n;
const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/;
const OPERATION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const FEATURES = [
  "atomic_consult",
  "durable_operations",
  "signed_receipts",
  "evidence",
  "session_keys",
  "public_submission",
  "private_submission",
  "http",
  "tasks",
] as const;
const CORE_FEATURES = [
  "atomic_consult",
  "durable_operations",
  "signed_receipts",
  "evidence",
] as const;
const CAPABILITY_ISSUANCE_GRACE_SECONDS = 1;

function isUint256(value: string, positive: boolean): boolean {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    return false;
  }
  if (value.length > 78) {
    return false;
  }

  const numeric = BigInt(value);

  return numeric <= UINT256_MAX && (!positive || numeric > 0n);
}

function isUnicodeLength(value: string, maximum: number): boolean {
  return value.length > 0 && Array.from(value).length <= maximum;
}

function isCanonicalUrl(value: string): boolean {
  if (
    value.length < 1 ||
    value.length > 2048 ||
    value.includes("#") ||
    /[\s\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    return false;
  }

  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.hash === "" &&
      parsed.href === value
    );
  } catch {
    return false;
  }
}

const canonicalUrl = z.string().refine(isCanonicalUrl);
const identifier = z.string().regex(IDENTIFIER);
const decimalUint256 = z.string().refine((value) => isUint256(value, false));
const positiveDecimalUint256 = z
  .string()
  .refine((value) => isUint256(value, true));
const address = z.string().regex(ADDRESS);

export const actorSchema = z
  .object({
    chain_id: positiveDecimalUint256,
    address,
  })
  .strict();

export const subjectSchema = z
  .object({
    kind: z.enum(["token", "wallet"]),
    chain_id: positiveDecimalUint256,
    address,
  })
  .strict();

export const qualitySchema = z
  .object({
    tier: z.enum(["standard", "enriched"]),
    max_age_seconds: z.number().int().min(0).max(86_400),
    finality: z.enum(["latest", "safe", "finalized"]),
    allow_partial: z.boolean(),
  })
  .strict();

export const maxCostSchema = z
  .object({
    unit: z.literal("earned_credit"),
    amount: decimalUint256,
  })
  .strict();

export const consultationSchema = z
  .object({
    protocol: z.literal(PROTOCOL_REVISION),
    schema_revision: z.literal(SCHEMA_REVISION),
    auth_profile: z.literal(AUTH_PROFILE),
    operation_id: z.string().regex(OPERATION_ID),
    actor: actorSchema,
    subject: subjectSchema,
    capability: z.enum(["token_overview", "wallet_overview"]),
    endpoint: canonicalUrl,
    audience: canonicalUrl,
    quality: qualitySchema,
    max_cost: maxCostSchema,
    deadline: z.number().int().min(0).max(MAX_UNIX_SECONDS),
  })
  .strict()
  .superRefine((value, context) => {
    const expectedCapability =
      value.subject.kind === "token" ? "token_overview" : "wallet_overview";
    if (value.capability !== expectedCapability) {
      context.addIssue({
        code: "custom",
        path: ["capability"],
        message: "Capability does not match the subject kind",
      });
    }
    if (value.quality.tier === "standard" && value.max_cost.amount !== "0") {
      context.addIssue({
        code: "custom",
        path: ["max_cost", "amount"],
        message: "Standard consultations require zero maximum cost",
      });
    }
  });

export type Consultation = z.infer<typeof consultationSchema>;

export const protocolIdentifierSchema = identifier;
export const canonicalHttpsUrlSchema = canonicalUrl;
export const uint256Schema = decimalUint256;
export const positiveUint256Schema = positiveDecimalUint256;
export const operationIdV2Schema = z.string().regex(OPERATION_ID);
export const protocolTimeSchema = z.number().int().min(0).max(MAX_UNIX_SECONDS);

const revisionArray = z
  .array(identifier)
  .min(1)
  .max(16)
  .refine((values) => new Set(values).size === values.length);

const featureSchema = z
  .object({
    capability: z.enum(FEATURES),
    status: z.enum(["installed", "verified", "not_applicable", "blocked"]),
    reason: z
      .string()
      .refine((value) => isUnicodeLength(value, 256))
      .optional(),
    next_action: z
      .string()
      .refine((value) => isUnicodeLength(value, 256))
      .optional(),
    evidence_revision: identifier.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "verified") {
      if (value.evidence_revision === undefined) {
        context.addIssue({
          code: "custom",
          path: ["evidence_revision"],
          message: "Verified capabilities require evidence revision",
        });
      }
      if (value.reason !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["reason"],
          message: "Verified capabilities cannot include a reason",
        });
      }
      if (value.next_action !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["next_action"],
          message: "Verified capabilities cannot include a next action",
        });
      }
      return;
    }
    if (value.reason === undefined || value.next_action === undefined) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "Unavailable capabilities require a reason and next action",
      });
    }
    if (value.evidence_revision !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["evidence_revision"],
        message: "Unavailable capabilities cannot include evidence revision",
      });
    }
  });

const limitsSchema = z
  .object({
    max_request_bytes: z
      .number()
      .int()
      .positive()
      .max(CANONICAL_LIMITS.maxBytes),
    max_depth: z.number().int().positive().max(CANONICAL_LIMITS.maxDepth),
    max_collection_items: z
      .number()
      .int()
      .positive()
      .max(CANONICAL_LIMITS.maxArrayItems),
  })
  .strict();

export const capabilitiesSchema = z
  .object({
    protocols: revisionArray,
    schema_revisions: revisionArray,
    auth_profiles: revisionArray,
    mcp_revision: identifier,
    server: z
      .object({
        id: identifier,
        revision: identifier,
      })
      .strict(),
    endpoint: canonicalUrl,
    audience: canonicalUrl,
    issued_at: z.number().int().min(0).max(MAX_UNIX_SECONDS),
    expires_at: z.number().int().min(0).max(MAX_UNIX_SECONDS),
    limits: limitsSchema,
    features: z
      .array(featureSchema)
      .max(FEATURES.length)
      .refine(
        (values) =>
          new Set(values.map((feature) => feature.capability)).size ===
          values.length,
      ),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.expires_at <= value.issued_at) {
      context.addIssue({
        code: "custom",
        path: ["expires_at"],
        message: "Capability expiry must follow issuance",
      });
    }
    if (value.expires_at - value.issued_at > 3600) {
      context.addIssue({
        code: "custom",
        path: ["expires_at"],
        message: "Capability reports cannot live longer than one hour",
      });
    }
  });

export type Capabilities = z.infer<typeof capabilitiesSchema>;

function validateCanonicalInput(input: unknown): void {
  try {
    canonicalJson(input);
  } catch (error) {
    if (error instanceof ProtocolError) {
      throw error;
    }

    throw new ProtocolError("invalid_request");
  }
}

function validateNow(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0 || now > MAX_UNIX_SECONDS) {
    throw new ProtocolError("invalid_request");
  }
}

function parseConsultationValue(input: unknown): Consultation {
  validateCanonicalInput(input);
  const parsed = consultationSchema.safeParse(input);
  if (!parsed.success) {
    throw new ProtocolError("invalid_request");
  }

  return parsed.data;
}

export function parseConsultation(input: unknown, now: number): Consultation {
  validateNow(now);
  const parsed = parseConsultationValue(input);
  if (parsed.deadline <= now) {
    throw new ProtocolError("expired_deadline");
  }

  return parsed;
}

export function consultationDigest(input: unknown): string {
  return canonicalDigest("request", parseConsultationValue(input));
}

export function negotiateCapabilities(
  input: unknown,
  expected: {
    endpoint: string;
    audience: string;
    mcp_revision: string;
    auth_profile: string;
  },
  now: number,
) {
  validateNow(now);
  validateCanonicalInput(input);

  if (
    typeof expected !== "object" ||
    expected === null ||
    typeof expected.endpoint !== "string" ||
    typeof expected.audience !== "string" ||
    typeof expected.mcp_revision !== "string" ||
    typeof expected.auth_profile !== "string" ||
    !isCanonicalUrl(expected.endpoint) ||
    !isCanonicalUrl(expected.audience) ||
    !IDENTIFIER.test(expected.mcp_revision) ||
    !IDENTIFIER.test(expected.auth_profile)
  ) {
    throw new ProtocolError("invalid_request");
  }
  if (expected.mcp_revision !== MCP_REVISION) {
    throw new ProtocolError("unsupported_version");
  }
  if (expected.auth_profile !== AUTH_PROFILE) {
    throw new ProtocolError("unsupported_auth_profile");
  }

  const parsed = capabilitiesSchema.safeParse(input);
  if (!parsed.success) {
    throw new ProtocolError("invalid_request");
  }
  const report = parsed.data;

  const issuedTooFarInFuture =
    report.issued_at - now > CAPABILITY_ISSUANCE_GRACE_SECONDS;
  if (issuedTooFarInFuture || now >= report.expires_at) {
    throw new ProtocolError("expired_capabilities");
  }
  if (
    report.endpoint !== expected.endpoint ||
    report.audience !== expected.audience
  ) {
    throw new ProtocolError("capability_mismatch");
  }
  if (!report.protocols.includes(PROTOCOL_REVISION)) {
    throw new ProtocolError("unsupported_version");
  }
  if (!report.schema_revisions.includes(SCHEMA_REVISION)) {
    throw new ProtocolError("unsupported_version");
  }
  if (report.mcp_revision !== expected.mcp_revision) {
    throw new ProtocolError("unsupported_version");
  }
  if (!report.auth_profiles.includes(AUTH_PROFILE)) {
    throw new ProtocolError("unsupported_auth_profile");
  }

  const features = new Map(
    report.features.map((feature) => [feature.capability, feature]),
  );
  for (const capability of CORE_FEATURES) {
    if (features.get(capability)?.status !== "verified") {
      throw new ProtocolError("unsupported_capability");
    }
  }

  return {
    protocol: PROTOCOL_REVISION,
    schema_revision: SCHEMA_REVISION,
    auth_profile: AUTH_PROFILE,
    mcp_revision: MCP_REVISION,
    endpoint: report.endpoint,
    audience: report.audience,
    server: report.server,
    expires_at: report.expires_at,
    limits: report.limits,
  };
}
