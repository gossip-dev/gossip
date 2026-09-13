import { z } from "zod";
import { canonicalDigest, PROTOCOL_REVISION } from "./canonical.js";
import { ProtocolError } from "./protocol-errors.js";

export const ACCEPTANCE_ENVELOPE_SCHEMA =
  "gossip.acceptance-envelope.v1" as const;
export const ACCEPTANCE_STATEMENT_SCHEMA =
  "gossip.acceptance-statement.v1" as const;
export const CONFORMANCE_SUITE_REVISION =
  "gossip-v2-conformance-2026-09-11.12" as const;

export const CONFORMANCE_SCENARIOS = [
  "artifact_install",
  "installed_cli_process",
  "mcp_http_parity",
  "authentication_fail_closed",
  "session_scope_escape",
  "public_submission_transport",
  "operation_exactly_once",
  "operation_conflict",
  "zero_cost_reconciliation",
  "persistence_fault_recovery",
  "evidence_finality_reorg",
  "correction_supersession",
  "owner_isolation",
  "privacy_canary_scan",
  "independent_vectors",
  "clean_checkout_reproduction",
] as const;

export const CONFORMANCE_CAPABILITIES = [
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

const CORE_CAPABILITIES = [
  "atomic_consult",
  "durable_operations",
  "signed_receipts",
  "evidence",
] as const;

const PROCESS_EVIDENCE_SCENARIOS = [
  "mcp_http_parity",
  "privacy_canary_scan",
  "operation_exactly_once",
  "operation_conflict",
  "authentication_fail_closed",
  "session_scope_escape",
  "public_submission_transport",
  "zero_cost_reconciliation",
  "persistence_fault_recovery",
  "evidence_finality_reorg",
  "correction_supersession",
  "owner_isolation",
] as const;

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/;
const MAX_UNIX_SECONDS = 253_402_300_799;
const MAX_CAPTURE_BYTES = 1_048_576;

const shortTextSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));

const relativePathSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => {
    if (
      value.includes("\\") ||
      value.startsWith("/") ||
      /^[A-Za-z]:/.test(value)
    ) {
      return false;
    }
    const segments = value.split("/");
    return segments.every(
      (segment) => segment.length > 0 && segment !== "." && segment !== "..",
    );
  });

const evidenceReferenceSchema = z
  .object({
    path: relativePathSchema,
    sha256: z.string().regex(DIGEST),
    bytes: z.number().int().min(0).max(1_000_000_000),
  })
  .strict();

const verifiedScenarioSchema = z
  .object({
    id: z.enum(CONFORMANCE_SCENARIOS),
    status: z.literal("verified"),
    assertions: z.number().int().positive().max(1_000_000),
    evidence: z.array(evidenceReferenceSchema).min(1).max(64),
  })
  .strict();

const unavailableScenarioSchema = z
  .object({
    id: z.enum(CONFORMANCE_SCENARIOS),
    status: z.enum(["blocked", "not_applicable"]),
    reason: shortTextSchema,
    next_action: shortTextSchema,
  })
  .strict();

const scenarioSchema = z.union([
  verifiedScenarioSchema,
  unavailableScenarioSchema,
]);

const verifiedCapabilitySchema = z
  .object({
    name: z.enum(CONFORMANCE_CAPABILITIES),
    state: z.literal("verified"),
    evidence_revision: z.string().regex(REVISION),
    evidence_scenarios: z
      .array(z.enum(CONFORMANCE_SCENARIOS))
      .min(1)
      .max(CONFORMANCE_SCENARIOS.length)
      .refine((values) => new Set(values).size === values.length),
  })
  .strict();

const unavailableCapabilitySchema = z
  .object({
    name: z.enum(CONFORMANCE_CAPABILITIES),
    state: z.enum(["installed", "blocked", "not_applicable"]),
    reason: shortTextSchema,
    next_action: shortTextSchema,
  })
  .strict();

const capabilitySchema = z.union([
  verifiedCapabilitySchema,
  unavailableCapabilitySchema,
]);

const acceptanceStatementSchema = z
  .object({
    schema: z.literal(ACCEPTANCE_STATEMENT_SCHEMA),
    suite_revision: z.literal(CONFORMANCE_SUITE_REVISION),
    protocol: z.literal(PROTOCOL_REVISION),
    generated_at: z.number().int().min(0).max(MAX_UNIX_SECONDS),
    source: z
      .object({
        repository: z.literal("https://github.com/gossip-dev/gossip"),
        commit: z.string().regex(COMMIT),
        dirty: z.literal(false),
      })
      .strict(),
    artifacts: z
      .object({
        gossip: z
          .object({
            package: z.literal("@gossip/agent-kit"),
            version: z.string().regex(VERSION),
            sha256: z.string().regex(DIGEST),
            bytes: z.number().int().positive().max(1_000_000_000),
          })
          .strict(),
        sherwood: z
          .object({
            repository: z.literal("https://github.com/gossip-dev/sherwood"),
            commit: z.string().regex(COMMIT).nullable(),
            assembly: z
              .object({
                sha256: z.string().regex(DIGEST),
                bytes: z.number().int().positive().max(1_000_000_000),
              })
              .strict()
              .nullable(),
            image_digest: z.string().regex(DIGEST).nullable(),
          })
          .strict()
          .refine(
            (value) =>
              (value.commit === null &&
                value.assembly === null &&
                value.image_digest === null) ||
              (value.commit !== null &&
                (value.assembly !== null || value.image_digest !== null)),
          ),
      })
      .strict(),
    runtime: z
      .object({
        os: z.enum(["aix", "darwin", "freebsd", "linux", "openbsd", "win32"]),
        architecture: z.enum([
          "arm",
          "arm64",
          "ia32",
          "loong64",
          "mips",
          "mipsel",
          "ppc",
          "ppc64",
          "riscv64",
          "s390",
          "s390x",
          "x64",
        ]),
        node: z.string().regex(VERSION),
        npm: z.string().regex(VERSION),
        python: z.string().regex(VERSION),
        dotnet: z.string().regex(VERSION).nullable(),
        docker: z.string().regex(VERSION).nullable(),
        postgresql: z.string().regex(VERSION).nullable(),
      })
      .strict(),
    revisions: z
      .object({
        schema: z.literal("2026-09-09"),
        auth: z.literal("gossip-eip191-v2"),
        mcp: z.literal("2025-11-25"),
        engine: z.string().regex(REVISION).nullable(),
        database_migrations: z.string().regex(REVISION).nullable(),
        fixture_suite: z.string().regex(REVISION),
      })
      .strict(),
    fixtures: z
      .array(
        z
          .object({
            name: z.string().regex(REVISION),
            path: relativePathSchema,
            sha256: z.string().regex(DIGEST),
            bytes: z.number().int().positive().max(1_000_000_000),
          })
          .strict(),
      )
      .min(1)
      .max(64),
    scenarios: z.array(scenarioSchema).length(CONFORMANCE_SCENARIOS.length),
    capabilities: z
      .array(capabilitySchema)
      .length(CONFORMANCE_CAPABILITIES.length),
    decision: z.enum(["verified", "blocked"]),
  })
  .strict()
  .superRefine((value, context) => {
    const names = value.fixtures.map((fixture) => fixture.name);
    const paths = value.fixtures.map((fixture) => fixture.path);
    if (
      new Set(names).size !== names.length ||
      new Set(paths).size !== paths.length
    ) {
      context.addIssue({ code: "custom", message: "Duplicate fixture" });
    }
  });

export type AcceptanceStatement = z.infer<typeof acceptanceStatementSchema>;

const acceptanceEnvelopeSchema = z
  .object({
    schema: z.literal(ACCEPTANCE_ENVELOPE_SCHEMA),
    statement: acceptanceStatementSchema,
    content_address: z
      .object({
        algorithm: z.literal("sha256"),
        digest: z.string().regex(DIGEST),
      })
      .strict(),
  })
  .strict();

export type AcceptanceEnvelope = z.infer<typeof acceptanceEnvelopeSchema>;

function invalidManifest(): never {
  throw new ProtocolError("invalid_conformance_manifest");
}

function hasExactMembers(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  return (
    actual.length === expected.length &&
    new Set(actual).size === expected.length &&
    expected.every((value) => actual.includes(value))
  );
}

function validateStatement(statement: AcceptanceStatement): void {
  if (
    !hasExactMembers(
      statement.scenarios.map((scenario) => scenario.id),
      CONFORMANCE_SCENARIOS,
    ) ||
    !hasExactMembers(
      statement.capabilities.map((capability) => capability.name),
      CONFORMANCE_CAPABILITIES,
    )
  ) {
    invalidManifest();
  }

  const scenarios = new Map(
    statement.scenarios.map((scenario) => [scenario.id, scenario]),
  );
  for (const capability of statement.capabilities) {
    if (
      capability.state === "verified" &&
      capability.evidence_scenarios.some(
        (scenarioId) => scenarios.get(scenarioId)?.status !== "verified",
      )
    ) {
      invalidManifest();
    }
  }

  const requiresProcessEvidence = PROCESS_EVIDENCE_SCENARIOS.some(
    (scenarioId) => scenarios.get(scenarioId)?.status === "verified",
  );
  if (requiresProcessEvidence) {
    const sherwood = statement.artifacts.sherwood;
    if (
      sherwood.commit === null ||
      sherwood.assembly === null ||
      statement.runtime.dotnet === null ||
      statement.runtime.docker === null ||
      statement.runtime.postgresql === null ||
      statement.revisions.engine === null ||
      statement.revisions.database_migrations === null
    ) {
      invalidManifest();
    }
  }

  if (statement.decision !== "verified") {
    return;
  }

  const engine = statement.artifacts.sherwood;
  const runtime = statement.runtime;
  const revisions = statement.revisions;
  const hasCompleteEngineEvidence =
    engine.commit !== null &&
    engine.image_digest !== null &&
    runtime.dotnet !== null &&
    runtime.docker !== null &&
    runtime.postgresql !== null &&
    revisions.engine !== null &&
    revisions.database_migrations !== null;
  const everyScenarioVerified = statement.scenarios.every(
    (scenario) => scenario.status === "verified",
  );
  const capabilities = new Map(
    statement.capabilities.map((capability) => [capability.name, capability]),
  );
  const everyCoreCapabilityVerified = CORE_CAPABILITIES.every(
    (capability) => capabilities.get(capability)?.state === "verified",
  );

  if (
    !hasCompleteEngineEvidence ||
    !everyScenarioVerified ||
    !everyCoreCapabilityVerified
  ) {
    invalidManifest();
  }
}

export function conformanceStatementDigest(input: unknown): string {
  const result = acceptanceStatementSchema.safeParse(input);
  if (!result.success) {
    invalidManifest();
  }
  validateStatement(result.data);
  return canonicalDigest("conformance", result.data);
}

export function createConformanceEnvelope(input: unknown): AcceptanceEnvelope {
  const statement = acceptanceStatementSchema.safeParse(input);
  if (!statement.success) {
    invalidManifest();
  }
  validateStatement(statement.data);

  return {
    schema: ACCEPTANCE_ENVELOPE_SCHEMA,
    statement: statement.data,
    content_address: {
      algorithm: "sha256",
      digest: conformanceStatementDigest(statement.data),
    },
  };
}

export function parseConformanceEnvelope(input: unknown): AcceptanceEnvelope {
  const result = acceptanceEnvelopeSchema.safeParse(input);
  if (!result.success) {
    invalidManifest();
  }
  validateStatement(result.data.statement);
  if (
    result.data.content_address.digest !==
    conformanceStatementDigest(result.data.statement)
  ) {
    invalidManifest();
  }
  return result.data;
}

const CAPTURE_FIELD = /(?:^|[[\],{;\s])["']?([^"'=:\r\n{},;]+)["']?\s*[:=]/gmu;
const PROHIBITED_FIELD_FRAGMENTS = [
  "authorization",
  "privatekey",
  "signature",
  "sourceurl",
  "prompt",
  "secret",
  "token",
] as const;

function isProhibitedFieldName(fieldName: string): boolean {
  const normalized = fieldName.replace(/[^A-Za-z0-9]/gu, "").toLowerCase();
  return PROHIBITED_FIELD_FRAGMENTS.some((fragment) =>
    normalized.includes(fragment),
  );
}

function hasProhibitedJsonField(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(hasProhibitedJsonField);
  }
  if (value === null || typeof value !== "object") {
    return false;
  }
  return Object.entries(value).some(
    ([fieldName, nested]) =>
      isProhibitedFieldName(fieldName) || hasProhibitedJsonField(nested),
  );
}

function hasProhibitedCaptureField(captured: string): boolean {
  try {
    if (hasProhibitedJsonField(JSON.parse(captured))) {
      return true;
    }
  } catch {
    // Line-oriented diagnostics are not necessarily JSON. Inspect every complete
    // key preceding ':' or '=' and normalize punctuation and casing.
  }

  for (const match of captured.matchAll(CAPTURE_FIELD)) {
    const fieldName = match[1];
    if (fieldName === undefined) {
      continue;
    }
    if (isProhibitedFieldName(fieldName)) {
      return true;
    }
  }
  return false;
}

export function scanConformanceText(
  captured: unknown,
  canaries: readonly string[],
): void {
  if (
    typeof captured !== "string" ||
    Buffer.byteLength(captured, "utf8") > MAX_CAPTURE_BYTES ||
    !Array.isArray(canaries) ||
    canaries.length > 64 ||
    canaries.some(
      (canary) =>
        typeof canary !== "string" || canary.length < 8 || canary.length > 128,
    ) ||
    /\bbearer\s+[A-Za-z0-9._~-]+/iu.test(captured) ||
    hasProhibitedCaptureField(captured) ||
    canaries.some((canary) => captured.includes(canary))
  ) {
    throw new ProtocolError("unsafe_conformance_artifact");
  }
}
