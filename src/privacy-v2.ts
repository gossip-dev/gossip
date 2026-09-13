import { z } from "zod";
import {
  canonicalDigest,
  canonicalJson,
  PROTOCOL_REVISION,
} from "./canonical.js";
import { verifyIdentitySignature } from "./identity-session.js";
import {
  MAX_UNIX_SECONDS,
  actorSchema,
  operationIdV2Schema,
} from "./protocol-v2.js";
import { ProtocolError } from "./protocol-errors.js";

export const PRIVACY_POLICY_SCHEMA = "gossip.privacy-policy.v1" as const;
export const PRIVACY_OPERATION_SCHEMA = "gossip.privacy-operation.v1" as const;
export const PUBLICATION_CONSENT_SCHEMA =
  "gossip.publication-consent.v1" as const;
export const PRIVATE_EVIDENCE_LIFECYCLE_SCHEMA =
  "gossip.private-evidence-lifecycle.v1" as const;
export const PRIVACY_TOMBSTONE_SCHEMA = "gossip.privacy-tombstone.v1" as const;
export const PRIVACY_DELETION_RESULT_SCHEMA =
  "gossip.privacy-deletion-result.v1" as const;
export const PRIVACY_CORRECTION_RESULT_SCHEMA =
  "gossip.privacy-correction-result.v1" as const;
export const PRIVACY_DELETION_OUTCOMES = [
  "deleted",
  "already_deleted",
  "held",
] as const;
export const PRIVACY_CORRECTION_OUTCOMES = [
  "corrected",
  "already_corrected",
] as const;
export const PRIVACY_AUDIT_SCHEMA = "gossip.privacy-audit.v1" as const;
export const PRIVACY_TELEMETRY_SCHEMA = "gossip.privacy-telemetry.v1" as const;
export const SYNTHETIC_PRIVACY_POLICY_REVISION =
  "private-evidence-synthetic-2026-09-10" as const;

export const PRIVATE_DATA_CLASSES = [
  "private_payload",
  "public_envelope",
  "operation",
  "receipt",
  "quarantine_record",
  "access_audit",
  "aggregate_metric",
] as const;

export const PRIVATE_OWNER_ACTIONS = [
  "export",
  "delete",
  "correct",
  "access_audit",
] as const;

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_POLICY_RETENTION_SECONDS = 315_576_000;
const PRIVATE_PAYLOAD_RETENTION_SECONDS = 2_592_000;
const MAX_CONSENT_SECONDS = 3_600;
const MAX_CORRELATION_SECONDS = 300;

const policyDataClassSchema = z
  .object({
    name: z.enum(PRIVATE_DATA_CLASSES),
    retention_seconds: z
      .number()
      .int()
      .positive()
      .max(MAX_POLICY_RETENTION_SECONDS),
    retention_clock: z.enum([
      "stored_at",
      "published_at",
      "accepted_at",
      "issued_at",
      "quarantined_at",
      "occurred_at",
      "window_end",
    ]),
    export: z.enum(["full", "metadata", "none"]),
    deletion: z.enum([
      "delete_payload_keep_tombstone",
      "retain_integrity_record",
      "delete_at_retention",
      "aggregate_only",
    ]),
    hold: z.enum(["defer_deletion", "not_applicable"]),
    immutable_history_exception: z.enum([
      "none",
      "published_commitment",
      "accepted_operation",
      "signed_receipt",
    ]),
  })
  .strict();

const ownerOperationPolicySchema = z
  .object({
    action: z.enum(PRIVATE_OWNER_ACTIONS),
    idempotent: z.literal(true),
    unavailable_error: z.literal("privacy_unavailable"),
    outcomes: z
      .array(
        z.enum([
          "exported",
          "deleted",
          "already_deleted",
          "held",
          "immutable",
          "corrected",
          "already_corrected",
          "returned",
          "unavailable",
        ]),
      )
      .min(2)
      .max(5)
      .refine((values) => new Set(values).size === values.length),
  })
  .strict();

const privacyPolicySchema = z
  .object({
    schema: z.literal(PRIVACY_POLICY_SCHEMA),
    protocol: z.literal(PROTOCOL_REVISION),
    revision: z.string().regex(REVISION),
    activation: z.literal("blocked_pending_approval"),
    product_approved: z.literal(false),
    raw_private_evidence: z.literal("offchain_encrypted_owner_scoped"),
    public_commitment_default: z.literal("forbidden_without_consent"),
    data_classes: z
      .array(policyDataClassSchema)
      .length(PRIVATE_DATA_CLASSES.length),
    owner_operations: z
      .array(ownerOperationPolicySchema)
      .length(PRIVATE_OWNER_ACTIONS.length),
  })
  .strict();

export type PrivacyPolicy = z.infer<typeof privacyPolicySchema>;

function deepFreeze<T>(value: T): Readonly<T> {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }

  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

export const SYNTHETIC_PRIVATE_EVIDENCE_POLICY = deepFreeze({
  schema: PRIVACY_POLICY_SCHEMA,
  protocol: PROTOCOL_REVISION,
  revision: SYNTHETIC_PRIVACY_POLICY_REVISION,
  activation: "blocked_pending_approval" as const,
  product_approved: false as const,
  raw_private_evidence: "offchain_encrypted_owner_scoped" as const,
  public_commitment_default: "forbidden_without_consent" as const,
  data_classes: [
    {
      name: "private_payload",
      retention_seconds: PRIVATE_PAYLOAD_RETENTION_SECONDS,
      retention_clock: "stored_at",
      export: "full",
      deletion: "delete_payload_keep_tombstone",
      hold: "defer_deletion",
      immutable_history_exception: "none",
    },
    {
      name: "public_envelope",
      retention_seconds: 31_557_600,
      retention_clock: "published_at",
      export: "metadata",
      deletion: "retain_integrity_record",
      hold: "not_applicable",
      immutable_history_exception: "published_commitment",
    },
    {
      name: "operation",
      retention_seconds: 31_557_600,
      retention_clock: "accepted_at",
      export: "metadata",
      deletion: "retain_integrity_record",
      hold: "not_applicable",
      immutable_history_exception: "accepted_operation",
    },
    {
      name: "receipt",
      retention_seconds: 31_557_600,
      retention_clock: "issued_at",
      export: "metadata",
      deletion: "retain_integrity_record",
      hold: "not_applicable",
      immutable_history_exception: "signed_receipt",
    },
    {
      name: "quarantine_record",
      retention_seconds: 604_800,
      retention_clock: "quarantined_at",
      export: "metadata",
      deletion: "delete_at_retention",
      hold: "defer_deletion",
      immutable_history_exception: "none",
    },
    {
      name: "access_audit",
      retention_seconds: 7_776_000,
      retention_clock: "occurred_at",
      export: "metadata",
      deletion: "delete_at_retention",
      hold: "defer_deletion",
      immutable_history_exception: "none",
    },
    {
      name: "aggregate_metric",
      retention_seconds: 2_592_000,
      retention_clock: "window_end",
      export: "none",
      deletion: "aggregate_only",
      hold: "not_applicable",
      immutable_history_exception: "none",
    },
  ],
  owner_operations: [
    {
      action: "export",
      idempotent: true,
      unavailable_error: "privacy_unavailable",
      outcomes: ["exported", "unavailable"],
    },
    {
      action: "delete",
      idempotent: true,
      unavailable_error: "privacy_unavailable",
      outcomes: [
        "deleted",
        "already_deleted",
        "held",
        "immutable",
        "unavailable",
      ],
    },
    {
      action: "correct",
      idempotent: true,
      unavailable_error: "privacy_unavailable",
      outcomes: ["corrected", "already_corrected", "unavailable"],
    },
    {
      action: "access_audit",
      idempotent: true,
      unavailable_error: "privacy_unavailable",
      outcomes: ["returned", "unavailable"],
    },
  ] as const,
});

function invalidPrivacyContract(): never {
  throw new ProtocolError("invalid_privacy_contract");
}

function sameActor(
  left: z.infer<typeof actorSchema>,
  right: z.infer<typeof actorSchema>,
): boolean {
  return left.chain_id === right.chain_id && left.address === right.address;
}

function hasExactMembers<T extends string>(
  actual: readonly T[],
  expected: readonly T[],
): boolean {
  return (
    actual.length === expected.length &&
    new Set(actual).size === expected.length &&
    expected.every((value) => actual.includes(value))
  );
}

export function parsePrivacyPolicy(input: unknown): PrivacyPolicy {
  const result = privacyPolicySchema.safeParse(input);
  if (!result.success) {
    invalidPrivacyContract();
  }

  if (
    !hasExactMembers(
      result.data.data_classes.map((entry) => entry.name),
      PRIVATE_DATA_CLASSES,
    ) ||
    !hasExactMembers(
      result.data.owner_operations.map((entry) => entry.action),
      PRIVATE_OWNER_ACTIONS,
    )
  ) {
    invalidPrivacyContract();
  }

  return result.data;
}

const exportActionSchema = z
  .object({ kind: z.literal("export"), scope: z.literal("all") })
  .strict();
const deleteActionSchema = z
  .object({
    kind: z.literal("delete"),
    evidence_digest: z.string().regex(DIGEST),
  })
  .strict();
const correctActionSchema = z
  .object({
    kind: z.literal("correct"),
    evidence_digest: z.string().regex(DIGEST),
    correction_digest: z.string().regex(DIGEST),
  })
  .strict()
  .refine((value) => value.evidence_digest !== value.correction_digest);
const accessAuditActionSchema = z
  .object({
    kind: z.literal("access_audit"),
    since: z.number().int().min(0).max(MAX_UNIX_SECONDS),
    until: z.number().int().min(0).max(MAX_UNIX_SECONDS),
  })
  .strict()
  .refine((value) => value.since <= value.until);

const privacyOperationSchema = z
  .object({
    schema: z.literal(PRIVACY_OPERATION_SCHEMA),
    protocol: z.literal(PROTOCOL_REVISION),
    policy_revision: z.string().regex(REVISION),
    operation_id: operationIdV2Schema,
    owner: actorSchema,
    requested_at: z.number().int().min(0).max(MAX_UNIX_SECONDS),
    action: z.discriminatedUnion("kind", [
      exportActionSchema,
      deleteActionSchema,
      correctActionSchema,
      accessAuditActionSchema,
    ]),
  })
  .strict();

export type PrivacyOperation = z.infer<typeof privacyOperationSchema>;

const privacyPrincipalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("root"), owner: actorSchema }).strict(),
  z
    .object({
      kind: z.literal("session"),
      owner: actorSchema,
      key_id: z.string().regex(RECORD_ID),
    })
    .strict(),
]);

export type PrivacyPrincipal = z.infer<typeof privacyPrincipalSchema>;
export type PrivacyOperationBinding = {
  operation_id: string;
  request_digest: string;
};

export function parsePrivacyOperation(input: unknown): PrivacyOperation {
  const result = privacyOperationSchema.safeParse(input);
  if (!result.success) {
    invalidPrivacyContract();
  }
  return result.data;
}

export function privacyOperationDigest(input: unknown): string {
  return canonicalDigest("request", parsePrivacyOperation(input));
}

export function bindPrivacyOperation(
  existing: PrivacyOperationBinding | null,
  input: unknown,
): PrivacyOperationBinding {
  const operation = parsePrivacyOperation(input);
  const binding = {
    operation_id: operation.operation_id,
    request_digest: privacyOperationDigest(operation),
  };

  if (existing === null) {
    return binding;
  }
  if (
    existing.operation_id !== binding.operation_id ||
    existing.request_digest !== binding.request_digest
  ) {
    throw new ProtocolError("operation_conflict");
  }
  return existing;
}

export function authorizePrivacyOperation(
  authenticatedPrincipal: unknown,
  input: unknown,
  expectedPolicyRevision: string,
): PrivacyOperation {
  const principal = privacyPrincipalSchema.safeParse(authenticatedPrincipal);
  const operation = parsePrivacyOperation(input);

  if (
    !principal.success ||
    principal.data.kind !== "root" ||
    !REVISION.test(expectedPolicyRevision) ||
    operation.policy_revision !== expectedPolicyRevision ||
    !sameActor(principal.data.owner, operation.owner)
  ) {
    throw new ProtocolError("privacy_unavailable");
  }

  return operation;
}

const publicationConsentSchema = z
  .object({
    schema: z.literal(PUBLICATION_CONSENT_SCHEMA),
    protocol: z.literal(PROTOCOL_REVISION),
    policy_revision: z.string().regex(REVISION),
    owner: actorSchema,
    evidence_digest: z.string().regex(DIGEST),
    disclosures: z
      .array(z.enum(["public_commitment", "linkable_identity"]))
      .min(1)
      .max(2)
      .refine((values) => new Set(values).size === values.length),
    issued_at: z.number().int().min(0).max(MAX_UNIX_SECONDS),
    expires_at: z.number().int().min(0).max(MAX_UNIX_SECONDS),
  })
  .strict()
  .refine(
    (value) =>
      value.expires_at > value.issued_at &&
      value.expires_at - value.issued_at <= MAX_CONSENT_SECONDS,
  );

export type PublicationConsent = z.infer<typeof publicationConsentSchema>;

const signedPublicationConsentSchema = z
  .object({
    consent: publicationConsentSchema,
    consent_digest: z.string().regex(DIGEST),
    root_public_key: z.string().regex(/^0x04[0-9a-f]{128}$/),
    signature: z.string().regex(/^0x[0-9a-f]{130}$/),
  })
  .strict();

export type SignedPublicationConsent = z.infer<
  typeof signedPublicationConsentSchema
>;

export function publicationConsentDigest(input: unknown): string {
  const result = publicationConsentSchema.safeParse(input);
  if (!result.success) {
    throw new ProtocolError("privacy_consent_required");
  }
  return canonicalDigest("identity", result.data);
}

export function publicationConsentMessage(consentDigest: string): string {
  if (!DIGEST.test(consentDigest)) {
    throw new ProtocolError("privacy_consent_required");
  }
  return [
    "Gossip publication consent v1",
    PROTOCOL_REVISION,
    PUBLICATION_CONSENT_SCHEMA,
    consentDigest,
  ].join("\n");
}

export function verifyPublicationConsent(
  input: unknown,
): SignedPublicationConsent {
  const result = signedPublicationConsentSchema.safeParse(input);
  if (!result.success) {
    throw new ProtocolError("privacy_consent_required");
  }
  if (
    result.data.consent_digest !== publicationConsentDigest(result.data.consent)
  ) {
    throw new ProtocolError("privacy_consent_required");
  }

  try {
    verifyIdentitySignature(
      result.data.root_public_key,
      result.data.signature,
      publicationConsentMessage(result.data.consent_digest),
      result.data.consent.owner.address,
    );
  } catch {
    throw new ProtocolError("privacy_consent_required");
  }

  return result.data;
}

export function requirePublicationConsent(
  authenticatedPrincipal: unknown,
  input: unknown,
  requested: {
    evidence_digest: string;
    disclosure: "public_commitment" | "linkable_identity";
    policy_revision: string;
    now: number;
  },
): void {
  let signedConsent: SignedPublicationConsent;
  try {
    signedConsent = verifyPublicationConsent(input);
  } catch {
    throw new ProtocolError("privacy_consent_required");
  }
  const consent = signedConsent.consent;
  const principal = privacyPrincipalSchema.safeParse(authenticatedPrincipal);
  const validTime =
    Number.isInteger(requested.now) &&
    requested.now >= 0 &&
    requested.now <= MAX_UNIX_SECONDS;

  if (
    !principal.success ||
    principal.data.kind !== "root" ||
    !validTime ||
    !sameActor(consent.owner, principal.data.owner) ||
    consent.policy_revision !== requested.policy_revision ||
    consent.evidence_digest !== requested.evidence_digest ||
    !consent.disclosures.includes(requested.disclosure) ||
    requested.now < consent.issued_at ||
    requested.now >= consent.expires_at
  ) {
    throw new ProtocolError("privacy_consent_required");
  }
}

const tombstoneSchema = z
  .object({
    schema: z.literal(PRIVACY_TOMBSTONE_SCHEMA),
    owner: actorSchema,
    evidence_digest: z.string().regex(DIGEST),
    policy_revision: z.string().regex(REVISION),
    reason: z.literal("owner_deletion"),
    deleted_at: z.number().int().min(0).max(MAX_UNIX_SECONDS),
    deletion_operation_id: operationIdV2Schema,
  })
  .strict();

const lifecycleRecordSchema = z
  .object({
    schema: z.literal(PRIVATE_EVIDENCE_LIFECYCLE_SCHEMA),
    owner: actorSchema,
    evidence_digest: z.string().regex(DIGEST),
    policy_revision: z.string().regex(REVISION),
    stored_at: z.number().int().min(0).max(MAX_UNIX_SECONDS),
    retention_expires_at: z.number().int().min(0).max(MAX_UNIX_SECONDS),
    hold: z
      .object({
        kind: z.enum(["legal", "operational"]),
        placed_at: z.number().int().min(0).max(MAX_UNIX_SECONDS),
      })
      .strict()
      .nullable(),
    correction_digests: z
      .array(z.string().regex(DIGEST))
      .max(64)
      .refine((values) => new Set(values).size === values.length),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.retention_expires_at !==
      value.stored_at + PRIVATE_PAYLOAD_RETENTION_SECONDS
    ) {
      context.addIssue({ code: "custom", message: "Invalid retention clock" });
    }
  });

export type PrivateEvidenceLifecycleRecord = z.infer<
  typeof lifecycleRecordSchema
>;

function parseLifecycleRecord(input: unknown): PrivateEvidenceLifecycleRecord {
  const result = lifecycleRecordSchema.safeParse(input);
  if (!result.success) {
    invalidPrivacyContract();
  }
  return result.data;
}

export type PrivacyTombstone = z.infer<typeof tombstoneSchema>;

function tombstoneMatchesOperation(
  tombstone: PrivacyTombstone,
  operation: PrivacyOperation,
): boolean {
  return (
    operation.action.kind === "delete" &&
    sameActor(operation.owner, tombstone.owner) &&
    operation.policy_revision === tombstone.policy_revision &&
    operation.action.evidence_digest === tombstone.evidence_digest &&
    operation.operation_id === tombstone.deletion_operation_id
  );
}

export function planPrivateEvidenceDeletion(
  authenticatedPrincipal: unknown,
  operationInput: unknown,
  recordInput: unknown,
  now: number,
):
  | {
      outcome: "deleted" | "already_deleted";
      tombstone: PrivacyTombstone;
    }
  | { outcome: "held"; record: PrivateEvidenceLifecycleRecord } {
  const operation = authorizePrivacyOperation(
    authenticatedPrincipal,
    operationInput,
    SYNTHETIC_PRIVACY_POLICY_REVISION,
  );

  const existingTombstone = tombstoneSchema.safeParse(recordInput);
  if (existingTombstone.success) {
    if (!tombstoneMatchesOperation(existingTombstone.data, operation)) {
      throw new ProtocolError("privacy_unavailable");
    }
    return { outcome: "already_deleted", tombstone: existingTombstone.data };
  }

  let record: PrivateEvidenceLifecycleRecord;
  try {
    record = parseLifecycleRecord(recordInput);
  } catch {
    throw new ProtocolError("privacy_unavailable");
  }

  if (
    operation.action.kind !== "delete" ||
    !sameActor(operation.owner, record.owner) ||
    operation.policy_revision !== record.policy_revision ||
    operation.action.evidence_digest !== record.evidence_digest
  ) {
    throw new ProtocolError("privacy_unavailable");
  }
  if (
    !Number.isInteger(now) ||
    now < operation.requested_at ||
    now < record.stored_at ||
    now > MAX_UNIX_SECONDS
  ) {
    invalidPrivacyContract();
  }
  if (record.hold !== null) {
    return { outcome: "held", record };
  }

  return {
    outcome: "deleted",
    tombstone: {
      schema: PRIVACY_TOMBSTONE_SCHEMA,
      owner: record.owner,
      evidence_digest: record.evidence_digest,
      policy_revision: SYNTHETIC_PRIVACY_POLICY_REVISION,
      reason: "owner_deletion",
      deleted_at: now,
      deletion_operation_id: operation.operation_id,
    },
  };
}

export function appendPrivateEvidenceCorrection(
  authenticatedPrincipal: unknown,
  operationInput: unknown,
  recordInput: unknown,
): PrivateEvidenceLifecycleRecord {
  const operation = authorizePrivacyOperation(
    authenticatedPrincipal,
    operationInput,
    SYNTHETIC_PRIVACY_POLICY_REVISION,
  );
  let record: PrivateEvidenceLifecycleRecord;
  try {
    record = parseLifecycleRecord(recordInput);
  } catch {
    throw new ProtocolError("privacy_unavailable");
  }

  if (
    operation.action.kind !== "correct" ||
    !sameActor(operation.owner, record.owner) ||
    operation.policy_revision !== record.policy_revision ||
    operation.action.evidence_digest !== record.evidence_digest
  ) {
    throw new ProtocolError("privacy_unavailable");
  }
  if (record.correction_digests.includes(operation.action.correction_digest)) {
    return record;
  }
  if (record.correction_digests.length === 64) {
    invalidPrivacyContract();
  }

  return {
    ...record,
    correction_digests: [
      ...record.correction_digests,
      operation.action.correction_digest,
    ],
  };
}

const privacyDeletionResultBase = {
  schema: z.literal(PRIVACY_DELETION_RESULT_SCHEMA),
  protocol: z.literal(PROTOCOL_REVISION),
  policy_revision: z.literal(SYNTHETIC_PRIVACY_POLICY_REVISION),
  owner: actorSchema,
  operation_id: operationIdV2Schema,
};

const privacyDeletionResultSchema = z
  .discriminatedUnion("outcome", [
    z
      .object({
        ...privacyDeletionResultBase,
        outcome: z.enum(["deleted", "already_deleted"]),
        tombstone: tombstoneSchema,
      })
      .strict(),
    z
      .object({
        ...privacyDeletionResultBase,
        outcome: z.literal("held"),
      })
      .strict(),
  ])
  .superRefine((value, context) => {
    if (value.outcome === "held") {
      return;
    }

    if (
      !sameActor(value.owner, value.tombstone.owner) ||
      value.policy_revision !== value.tombstone.policy_revision ||
      value.operation_id !== value.tombstone.deletion_operation_id
    ) {
      context.addIssue({
        code: "custom",
        message: "Deletion tombstone does not match its result binding",
      });
    }
  });

const privacyCorrectionResultSchema = z
  .object({
    schema: z.literal(PRIVACY_CORRECTION_RESULT_SCHEMA),
    protocol: z.literal(PROTOCOL_REVISION),
    policy_revision: z.literal(SYNTHETIC_PRIVACY_POLICY_REVISION),
    owner: actorSchema,
    operation_id: operationIdV2Schema,
    outcome: z.enum(PRIVACY_CORRECTION_OUTCOMES),
    correction_digests: z
      .array(z.string().regex(DIGEST))
      .min(1)
      .max(64)
      .refine((values) => new Set(values).size === values.length),
  })
  .strict();

export type PrivacyDeletionResult = z.infer<typeof privacyDeletionResultSchema>;
export type PrivacyCorrectionResult = z.infer<
  typeof privacyCorrectionResultSchema
>;

export function parsePrivacyDeletionResult(
  input: unknown,
): PrivacyDeletionResult {
  const result = privacyDeletionResultSchema.safeParse(input);
  if (!result.success) {
    invalidPrivacyContract();
  }
  return result.data;
}

export function parsePrivacyCorrectionResult(
  input: unknown,
): PrivacyCorrectionResult {
  const result = privacyCorrectionResultSchema.safeParse(input);
  if (!result.success) {
    invalidPrivacyContract();
  }
  return result.data;
}

export function buildPrivateEvidenceDeletionResult(
  authenticatedPrincipal: unknown,
  operationInput: unknown,
  recordInput: unknown,
  now: number,
): PrivacyDeletionResult {
  const planned = planPrivateEvidenceDeletion(
    authenticatedPrincipal,
    operationInput,
    recordInput,
    now,
  );
  const operation = authorizePrivacyOperation(
    authenticatedPrincipal,
    operationInput,
    SYNTHETIC_PRIVACY_POLICY_REVISION,
  );

  if (planned.outcome === "held") {
    return {
      schema: PRIVACY_DELETION_RESULT_SCHEMA,
      protocol: PROTOCOL_REVISION,
      policy_revision: SYNTHETIC_PRIVACY_POLICY_REVISION,
      owner: operation.owner,
      operation_id: operation.operation_id,
      outcome: "held",
    };
  }

  return {
    schema: PRIVACY_DELETION_RESULT_SCHEMA,
    protocol: PROTOCOL_REVISION,
    policy_revision: SYNTHETIC_PRIVACY_POLICY_REVISION,
    owner: operation.owner,
    operation_id: operation.operation_id,
    outcome: planned.outcome,
    tombstone: planned.tombstone,
  };
}

export function buildPrivateEvidenceCorrectionResult(
  authenticatedPrincipal: unknown,
  operationInput: unknown,
  recordInput: unknown,
): PrivacyCorrectionResult {
  const operation = authorizePrivacyOperation(
    authenticatedPrincipal,
    operationInput,
    SYNTHETIC_PRIVACY_POLICY_REVISION,
  );
  if (operation.action.kind !== "correct") {
    throw new ProtocolError("privacy_unavailable");
  }

  const before = lifecycleRecordSchema.safeParse(recordInput);
  const corrected = appendPrivateEvidenceCorrection(
    authenticatedPrincipal,
    operationInput,
    recordInput,
  );
  if (!before.success) {
    throw new ProtocolError("privacy_unavailable");
  }

  const alreadyCorrected = before.data.correction_digests.includes(
    operation.action.correction_digest,
  );
  return {
    schema: PRIVACY_CORRECTION_RESULT_SCHEMA,
    protocol: PROTOCOL_REVISION,
    policy_revision: SYNTHETIC_PRIVACY_POLICY_REVISION,
    owner: operation.owner,
    operation_id: operation.operation_id,
    outcome: alreadyCorrected ? "already_corrected" : "corrected",
    correction_digests: corrected.correction_digests,
  };
}

const storedOwnerExportRecordSchema = z
  .object({
    owner: actorSchema,
    data_class: z.enum(PRIVATE_DATA_CLASSES),
    record_id: z.string().regex(RECORD_ID),
    created_at: z.number().int().min(0).max(MAX_UNIX_SECONDS),
    owner_data: z.record(z.string(), z.unknown()),
  })
  .strict();

type OwnerExportRecord = Omit<
  z.infer<typeof storedOwnerExportRecordSchema>,
  "owner"
>;

const PROHIBITED_EXPORT_KEY_FRAGMENTS = [
  "accesstoken",
  "apikey",
  "authorization",
  "clientsecret",
  "credential",
  "encryptionkey",
  "encryptionkeyid",
  "internaltoken",
  "keystore",
  "keymaterial",
  "mnemonic",
  "password",
  "privatekey",
  "recoveryphrase",
  "refreshtoken",
  "secret",
  "seedphrase",
  "serversecret",
  "signingkey",
  "storagecredential",
  // Opaque owner data cannot distinguish a market-token field from a bearer
  // token. Exported market metadata must use asset-specific field names.
  "token",
] as const;

function assertNoServerOnlyMaterial(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(assertNoServerOnlyMaterial);
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }

  for (const [key, nested] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (
      PROHIBITED_EXPORT_KEY_FRAGMENTS.some((fragment) =>
        normalizedKey.includes(fragment),
      )
    ) {
      invalidPrivacyContract();
    }
    assertNoServerOnlyMaterial(nested);
  }
}

export function buildOwnerPrivacyExport(
  authenticatedPrincipal: unknown,
  operationInput: unknown,
  exportedAt: number,
  recordsInput: unknown,
): {
  schema: "gossip.privacy-export.v1";
  protocol: typeof PROTOCOL_REVISION;
  policy_revision: string;
  owner: z.infer<typeof actorSchema>;
  operation_id: string;
  exported_at: number;
  records: OwnerExportRecord[];
} {
  const operation = authorizePrivacyOperation(
    authenticatedPrincipal,
    operationInput,
    SYNTHETIC_PRIVACY_POLICY_REVISION,
  );
  if (operation.action.kind !== "export") {
    throw new ProtocolError("privacy_unavailable");
  }
  if (
    !Number.isInteger(exportedAt) ||
    exportedAt < operation.requested_at ||
    exportedAt > MAX_UNIX_SECONDS
  ) {
    invalidPrivacyContract();
  }
  if (!Array.isArray(recordsInput)) {
    throw new ProtocolError("privacy_unavailable");
  }
  if (recordsInput.length > 1_024) {
    invalidPrivacyContract();
  }
  for (let index = 0; index < recordsInput.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(recordsInput, index)) {
      invalidPrivacyContract();
    }
  }

  const records = recordsInput.map((input) => {
    const result = storedOwnerExportRecordSchema.safeParse(input);
    if (!result.success) {
      invalidPrivacyContract();
    }
    if (!sameActor(result.data.owner, operation.owner)) {
      throw new ProtocolError("privacy_unavailable");
    }
    try {
      canonicalJson(result.data.owner_data);
      assertNoServerOnlyMaterial(result.data.owner_data);
    } catch {
      invalidPrivacyContract();
    }
    const policy = SYNTHETIC_PRIVATE_EVIDENCE_POLICY.data_classes.find(
      (entry) => entry.name === result.data.data_class,
    );
    if (policy?.export === "none") {
      invalidPrivacyContract();
    }
    const { owner: _owner, ...exportedRecord } = result.data;
    return exportedRecord;
  });
  const identities = records.map(
    (record) => `${record.data_class}\u0000${record.record_id}`,
  );
  if (new Set(identities).size !== identities.length) {
    invalidPrivacyContract();
  }

  records.sort((left, right) => {
    const leftKey = `${left.data_class}\u0000${left.record_id}`;
    const rightKey = `${right.data_class}\u0000${right.record_id}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });

  return {
    schema: "gossip.privacy-export.v1",
    protocol: PROTOCOL_REVISION,
    policy_revision: operation.policy_revision,
    owner: operation.owner,
    operation_id: operation.operation_id,
    exported_at: exportedAt,
    records,
  };
}

const privacyTelemetrySchema = z
  .object({
    schema: z.literal(PRIVACY_TELEMETRY_SCHEMA),
    event: z.enum([
      "private_submission_blocked",
      "privacy_operation_started",
      "privacy_operation_completed",
      "privacy_operation_rejected",
    ]),
    correlation: z
      .object({
        id: z.string().regex(UUID_V7),
        issued_at: z.number().int().min(0).max(MAX_UNIX_SECONDS),
        expires_at: z.number().int().min(0).max(MAX_UNIX_SECONDS),
      })
      .strict(),
    occurred_at: z.number().int().min(0).max(MAX_UNIX_SECONDS),
    status: z.enum(["ok", "blocked", "unavailable", "rejected", "failed"]),
    error_code: z
      .enum([
        "none",
        "invalid_request",
        "privacy_unavailable",
        "privacy_hold",
        "internal_failure",
      ])
      .optional(),
    measurements: z
      .object({
        duration_ms: z.number().int().min(0).max(86_400_000).optional(),
        item_count: z.number().int().min(0).max(1_000_000).optional(),
        bytes_count: z.number().int().min(0).max(1_000_000_000).optional(),
      })
      .strict(),
  })
  .strict()
  .refine(
    (value) =>
      value.correlation.expires_at > value.correlation.issued_at &&
      value.correlation.expires_at - value.correlation.issued_at <=
        MAX_CORRELATION_SECONDS &&
      value.occurred_at >= value.correlation.issued_at &&
      value.occurred_at <= value.correlation.expires_at,
  );

const privacyAuditSchema = z
  .object({
    schema: z.literal(PRIVACY_AUDIT_SCHEMA),
    audit_id: z.string().regex(UUID_V7),
    occurred_at: z.number().int().min(0).max(MAX_UNIX_SECONDS),
    action: z.enum(["read", ...PRIVATE_OWNER_ACTIONS]),
    record_class: z.enum(PRIVATE_DATA_CLASSES),
    outcome: z.enum(["allowed", "unavailable", "deleted", "held", "failed"]),
    item_count: z.number().int().min(0).max(1_000_000),
    correlation_id: z.string().regex(UUID_V7),
    policy_revision: z.string().regex(REVISION),
  })
  .strict();

export type PrivacyAuditEvent = z.infer<typeof privacyAuditSchema>;

export function parsePrivacyAuditEvent(input: unknown): PrivacyAuditEvent {
  const result = privacyAuditSchema.safeParse(input);
  if (!result.success) {
    invalidPrivacyContract();
  }
  return result.data;
}

const ownerPrivacyAuditRecordSchema = z
  .object({
    owner: actorSchema,
    event: privacyAuditSchema,
  })
  .strict();

export function buildOwnerAccessAudit(
  authenticatedPrincipal: unknown,
  operationInput: unknown,
  recordsInput: unknown,
): {
  schema: "gossip.privacy-access-audit.v1";
  protocol: typeof PROTOCOL_REVISION;
  policy_revision: string;
  owner: z.infer<typeof actorSchema>;
  operation_id: string;
  since: number;
  until: number;
  records: PrivacyAuditEvent[];
} {
  const operation = authorizePrivacyOperation(
    authenticatedPrincipal,
    operationInput,
    SYNTHETIC_PRIVACY_POLICY_REVISION,
  );
  if (operation.action.kind !== "access_audit") {
    throw new ProtocolError("privacy_unavailable");
  }
  const action = operation.action;
  if (!Array.isArray(recordsInput)) {
    throw new ProtocolError("privacy_unavailable");
  }
  if (recordsInput.length > 1_024) {
    invalidPrivacyContract();
  }

  const records = recordsInput.map((input) => {
    const result = ownerPrivacyAuditRecordSchema.safeParse(input);
    if (!result.success) {
      invalidPrivacyContract();
    }
    return result.data;
  });
  const selected = records
    .filter(
      (record) =>
        sameActor(record.owner, operation.owner) &&
        record.event.occurred_at >= action.since &&
        record.event.occurred_at <= action.until,
    )
    .map((record) => record.event)
    .sort((left, right) => {
      if (left.occurred_at !== right.occurred_at) {
        return left.occurred_at - right.occurred_at;
      }
      return left.audit_id < right.audit_id
        ? -1
        : left.audit_id > right.audit_id
          ? 1
          : 0;
    });

  return {
    schema: "gossip.privacy-access-audit.v1",
    protocol: PROTOCOL_REVISION,
    policy_revision: operation.policy_revision,
    owner: operation.owner,
    operation_id: operation.operation_id,
    since: action.since,
    until: action.until,
    records: selected,
  };
}

export type PrivacyTelemetryEvent = z.infer<typeof privacyTelemetrySchema>;

export function parsePrivacyTelemetryEvent(
  input: unknown,
  now: number,
): PrivacyTelemetryEvent {
  const result = privacyTelemetrySchema.safeParse(input);
  if (
    !result.success ||
    !Number.isInteger(now) ||
    now < result.data.correlation.issued_at ||
    now > result.data.correlation.expires_at
  ) {
    throw new ProtocolError("unsafe_telemetry");
  }
  return result.data;
}
