import { canonicalDigest, canonicalJson } from "./canonical.js";
import {
  PROTOCOL_REVISION,
  SCHEMA_REVISION,
  actorSchema,
  canonicalHttpsUrlSchema,
  operationIdV2Schema,
  subjectSchema,
} from "./protocol-v2.js";
import { ProtocolError } from "./protocol-errors.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const HASH = /^0x[0-9a-f]{64}$/;
const UINT = /^(?:0|[1-9][0-9]*)$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const MAX_TIME = 253402300799;
type Dict = Record<string, unknown>;

function boundedText(value: unknown, maximum = 256): string {
  const result = text(value);
  if (Array.from(result).length > maximum) fail("invalid_evidence");
  return result;
}

function decimal(value: unknown): string {
  const result = text(value);
  if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/.test(result)) {
    fail("invalid_evidence");
  }
  const unsigned = result.startsWith("-") ? result.slice(1) : result;
  const parts = unsigned.split(".", 2);
  const integer = parts[0] ?? "";
  const fraction = parts[1];
  const digits = integer.length + (fraction?.length ?? 0);
  if (
    result === "-0" ||
    (result.startsWith("-") && /^0(?:\.0+)?$/.test(unsigned)) ||
    digits > 78 ||
    (fraction?.length ?? 0) > 18
  )
    fail("invalid_evidence");
  if (
    !/^(?:0|[1-9][0-9]*)$/.test(integer) ||
    (fraction !== undefined &&
      (!/^[0-9]+$/.test(fraction) || fraction.endsWith("0")))
  )
    fail("invalid_evidence");
  return result;
}

export type EvidenceSubject = {
  kind: "token" | "wallet";
  chain_id: string;
  address: string;
};
export type EvidenceActor = { chain_id: string; address: string };
export type EvidenceValue =
  | { state: "known"; type: "boolean"; value: boolean }
  | { state: "known"; type: "text"; value: string }
  | {
      state: "known";
      type: "decimal";
      value: string;
      unit: string;
    }
  | {
      state: "unknown";
      reason: "unavailable" | "not_measured" | "not_applicable" | "conflicting";
    };
export type EvidenceValidity =
  | {
      type: "chain";
      chain_id: string;
      block_number: string;
      block_hash: string;
      block_timestamp: number;
      transaction_hash: string | null;
      log_index: string | null;
      finality: "latest" | "safe" | "finalized" | "unknown";
      canonicality: "canonical" | "unknown" | "invalidated";
      window: { start: number; end: number };
      expires_at: number | null;
    }
  | {
      type: "source";
      window: { start: number; end: number };
      expires_at: number | null;
      basis:
        | { type: "snapshot" }
        | {
            type: "issuer_interval";
            valid_from: number;
            valid_until: number;
          };
    };
export type EvidenceSource = {
  source_id: string;
  revision: string;
  content_hash: string;
  location:
    | { visibility: "public"; uri: string }
    | { visibility: "owner"; reference: string };
};
export type EvidenceVerification =
  | {
      mode: "replay";
      method: string;
      revision: string;
      source_ids: string[];
      instructions: string;
    }
  | { mode: "unavailable"; reason: string };
export type EvidenceAccess =
  | { visibility: "public" }
  | {
      visibility: "owner";
      owner: EvidenceActor;
      policy_revision: string;
    };
export type EvidencePayload = {
  protocol: typeof PROTOCOL_REVISION;
  schema_revision: typeof SCHEMA_REVISION;
  schema: "gossip.evidence.v1";
  subject: EvidenceSubject;
  kind: "chain_observation" | "source_observation" | "research_heuristic";
  claim: {
    predicate: string;
    value: EvidenceValue;
    limitations: string[];
  };
  provenance: "observed" | "relayed" | "inferred";
  observed_at: number;
  validity: EvidenceValidity;
  sources: EvidenceSource[];
  verification: EvidenceVerification;
  confidence: Array<{
    component: "reproducibility" | "corroboration" | "coverage";
    assessment: "supported" | "unsupported" | "unknown";
    explanation: string;
  }>;
  access: EvidenceAccess;
  derived_from: string[];
  supersedes: string | null;
  correction_reason: string | null;
  conflicts_with: string[];
};
export type EvidenceEnvelope = { digest: string; evidence: EvidencePayload };
export type EvidenceGraph = { roots: string[]; bundles: EvidenceEnvelope[] };
export type ResultManifest = {
  protocol: typeof PROTOCOL_REVISION;
  schema_revision: typeof SCHEMA_REVISION;
  schema: "gossip.result.v2";
  subject: EvidenceSubject;
  evidence_digests: string[];
};
export type EvidenceAssessment = {
  valid: boolean;
  reasons: string[];
  oldest_validity_end: number | null;
};

function fail(
  code:
    | "invalid_evidence"
    | "invalid_lineage"
    | "digest_mismatch"
    | "evidence_unavailable"
    | "limit_exceeded",
): never {
  throw new ProtocolError(code);
}
function dict(value: unknown): Dict {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail("invalid_evidence");
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
    fail("invalid_evidence");
  return result;
}
function text(value: unknown, pattern = /[\s\S]/u): string {
  if (typeof value !== "string" || !pattern.test(value))
    fail("invalid_evidence");
  return value;
}
function uint(value: unknown): string {
  if (typeof value !== "string" || !UINT.test(value)) fail("invalid_evidence");
  if (value.length > 78 || BigInt(value) > (1n << 256n) - 1n)
    fail("invalid_evidence");
  return value;
}
function time(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_TIME
  )
    fail("invalid_evidence");
  return value;
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value)) fail("invalid_evidence");
  if (value.length > max) fail("limit_exceeded");
  return value;
}
function digests(value: unknown, minimum = 0, maximum = 16): string[] {
  const values = array(value, maximum).map((item) => text(item, DIGEST));
  if (
    values.length < minimum ||
    values.some((item, index) => index > 0 && values[index - 1]! >= item)
  )
    fail("invalid_lineage");
  return values;
}
function actor(value: unknown): EvidenceActor {
  const parsed = actorSchema.safeParse(value);
  if (!parsed.success) {
    fail("invalid_evidence");
  }
  return parsed.data;
}

function subject(value: unknown): EvidenceSubject {
  const parsed = subjectSchema.safeParse(value);
  if (!parsed.success) {
    fail("invalid_evidence");
  }
  return parsed.data;
}

function claim(value: unknown): void {
  const result = strict(
    value,
    ["predicate", "value", "limitations"],
    ["predicate", "value", "limitations"],
  );
  text(result.predicate, IDENTIFIER);
  const known = dict(result.value);
  if (known.state === "known") {
    if (known.type === "boolean") {
      strict(known, ["state", "type", "value"], ["state", "type", "value"]);
      if (typeof known.value !== "boolean") {
        fail("invalid_evidence");
      }
    } else if (known.type === "text") {
      strict(known, ["state", "type", "value"], ["state", "type", "value"]);
      boundedText(known.value, 512);
    } else if (known.type === "decimal") {
      strict(
        known,
        ["state", "type", "value", "unit"],
        ["state", "type", "value", "unit"],
      );
      decimal(known.value);
      text(known.unit, IDENTIFIER);
    } else {
      fail("invalid_evidence");
    }
  } else if (known.state === "unknown") {
    strict(known, ["state", "reason"], ["state", "reason"]);
    if (
      ![
        "unavailable",
        "not_measured",
        "not_applicable",
        "conflicting",
      ].includes(known.reason as string)
    ) {
      fail("invalid_evidence");
    }
  } else {
    fail("invalid_evidence");
  }
  for (const limitation of array(result.limitations, 8)) {
    boundedText(limitation);
  }
}

function validity(value: unknown, subjectValue: Dict, observed: number): void {
  const result = dict(value);
  if (result.type !== "chain" && result.type !== "source")
    fail("invalid_evidence");
  const window = strict(result.window, ["start", "end"], ["start", "end"]);
  const start = time(window.start);
  const end = time(window.end);
  const expires = result.expires_at === null ? null : time(result.expires_at);
  if (start > end || end > observed || (expires !== null && expires <= end))
    fail("invalid_evidence");
  if (result.type === "chain") {
    strict(
      result,
      [
        "type",
        "chain_id",
        "block_number",
        "block_hash",
        "block_timestamp",
        "transaction_hash",
        "log_index",
        "finality",
        "canonicality",
        "window",
        "expires_at",
      ],
      [
        "type",
        "chain_id",
        "block_number",
        "block_hash",
        "block_timestamp",
        "transaction_hash",
        "log_index",
        "finality",
        "canonicality",
        "window",
        "expires_at",
      ],
    );
    if (
      result.chain_id !== subjectValue.chain_id ||
      typeof result.chain_id !== "string" ||
      !UINT.test(result.chain_id) ||
      typeof result.block_hash !== "string" ||
      !HASH.test(result.block_hash) ||
      uint(result.block_number) === "" ||
      time(result.block_timestamp) !== end ||
      typeof result.finality !== "string" ||
      !["latest", "safe", "finalized", "unknown"].includes(result.finality) ||
      typeof result.canonicality !== "string" ||
      !["canonical", "unknown", "invalidated"].includes(result.canonicality)
    )
      fail("invalid_evidence");
    if (
      result.transaction_hash !== null &&
      (typeof result.transaction_hash !== "string" ||
        !HASH.test(result.transaction_hash))
    )
      fail("invalid_evidence");
    if (
      result.log_index !== null &&
      (result.transaction_hash === null || uint(result.log_index) === "")
    )
      fail("invalid_evidence");
  } else {
    strict(
      result,
      ["type", "window", "expires_at", "basis"],
      ["type", "window", "expires_at", "basis"],
    );
    const basis = dict(result.basis);
    if (basis.type === "issuer_interval") {
      strict(
        basis,
        ["type", "valid_from", "valid_until"],
        ["type", "valid_from", "valid_until"],
      );
      if (!(time(basis.valid_from) <= end && end < time(basis.valid_until))) {
        fail("invalid_evidence");
      }
    } else if (basis.type === "snapshot") {
      strict(basis, ["type"], ["type"]);
    } else {
      fail("invalid_evidence");
    }
  }
}
function sources(value: unknown): unknown[] {
  const values = array(value, 16);
  if (values.length < 1) fail("invalid_evidence");
  return values.map((entry) => {
    const result = strict(
      entry,
      ["source_id", "revision", "content_hash", "location"],
      ["source_id", "revision", "content_hash", "location"],
    );
    text(result.source_id, IDENTIFIER);
    text(result.revision, IDENTIFIER);
    text(result.content_hash, DIGEST);
    const location = dict(result.location);
    if (location.visibility === "public") {
      strict(location, ["visibility", "uri"], ["visibility", "uri"]);
      if (!canonicalHttpsUrlSchema.safeParse(location.uri).success)
        fail("invalid_evidence");
    } else if (location.visibility === "owner") {
      strict(
        location,
        ["visibility", "reference"],
        ["visibility", "reference"],
      );
      if (!operationIdV2Schema.safeParse(location.reference).success) {
        fail("invalid_evidence");
      }
    } else {
      fail("invalid_evidence");
    }
    return result;
  });
}

function payload(input: unknown): EvidencePayload {
  canonicalJson(input);
  const result = strict(
    input,
    [
      "protocol",
      "schema_revision",
      "schema",
      "subject",
      "kind",
      "claim",
      "provenance",
      "observed_at",
      "validity",
      "sources",
      "verification",
      "confidence",
      "access",
      "derived_from",
      "supersedes",
      "correction_reason",
      "conflicts_with",
    ],
    [
      "protocol",
      "schema_revision",
      "schema",
      "subject",
      "kind",
      "claim",
      "provenance",
      "observed_at",
      "validity",
      "sources",
      "verification",
      "confidence",
      "access",
      "derived_from",
      "supersedes",
      "correction_reason",
      "conflicts_with",
    ],
  );
  if (
    result.protocol !== PROTOCOL_REVISION ||
    result.schema_revision !== SCHEMA_REVISION ||
    result.schema !== "gossip.evidence.v1"
  )
    fail("invalid_evidence");
  const subjectValue = subject(result.subject);
  text(
    result.kind,
    /^(chain_observation|source_observation|research_heuristic)$/,
  );
  claim(result.claim);
  text(result.provenance, /^(observed|relayed|inferred)$/);
  const observed = time(result.observed_at);
  validity(result.validity, subjectValue, observed);
  const parents = digests(result.derived_from, 0, 16);
  const validityType = (result.validity as Dict).type;
  if (
    (result.kind === "chain_observation" &&
      (validityType !== "chain" || result.provenance !== "observed")) ||
    (result.kind === "source_observation" &&
      (validityType !== "source" ||
        typeof result.provenance !== "string" ||
        !["observed", "relayed"].includes(result.provenance))) ||
    (result.kind === "research_heuristic" &&
      (result.provenance !== "inferred" ||
        parents.length === 0 ||
        !((result.claim as Dict).limitations as unknown[]).length))
  ) {
    fail("invalid_evidence");
  }
  const sourceValues = sources(result.sources);
  const verification = dict(result.verification);
  if (verification.mode === "replay") {
    strict(
      verification,
      ["mode", "method", "revision", "source_ids", "instructions"],
      ["mode", "method", "revision", "source_ids", "instructions"],
    );
    text(verification.method, IDENTIFIER);
    text(verification.revision, IDENTIFIER);
    const sourceIds = array(verification.source_ids, 16).map((item) =>
      text(item, IDENTIFIER),
    );
    if (
      sourceIds.length === 0 ||
      new Set(sourceIds).size !== sourceIds.length ||
      sourceIds.some(
        (id) =>
          !sourceValues.some((source) => (source as Dict).source_id === id),
      )
    )
      fail("invalid_evidence");
    boundedText(verification.instructions, 2048);
  } else if (verification.mode === "unavailable") {
    strict(verification, ["mode", "reason"], ["mode", "reason"]);
    boundedText(verification.reason);
  } else {
    fail("invalid_evidence");
  }
  if (
    sourceValues.length !==
    new Set(sourceValues.map((item) => (item as Dict).source_id)).size
  )
    fail("invalid_evidence");
  const confidenceItems = array(result.confidence, 3);
  const confidenceComponents = new Set<string>();
  confidenceItems.forEach((item) => {
    const confidence = strict(
      item,
      ["component", "assessment", "explanation"],
      ["component", "assessment", "explanation"],
    );
    text(confidence.component, /^(reproducibility|corroboration|coverage)$/);
    if (confidenceComponents.has(confidence.component as string))
      fail("invalid_evidence");
    confidenceComponents.add(confidence.component as string);
    text(confidence.assessment, /^(supported|unsupported|unknown)$/);
    boundedText(confidence.explanation);
  });
  const access = dict(result.access);
  if (access.visibility === "public")
    strict(access, ["visibility"], ["visibility"]);
  else if (access.visibility === "owner") {
    strict(
      access,
      ["visibility", "owner", "policy_revision"],
      ["visibility", "owner", "policy_revision"],
    );
    actor(access.owner);
    text(access.policy_revision, IDENTIFIER);
  } else fail("invalid_evidence");
  if (
    access.visibility === "public" &&
    sourceValues.some(
      (source) => ((source as Dict).location as Dict).visibility === "owner",
    )
  )
    fail("invalid_evidence");
  const supersedes =
    result.supersedes === null ? null : text(result.supersedes, DIGEST);
  if ((supersedes === null) !== (result.correction_reason === null))
    fail("invalid_lineage");
  if (result.correction_reason !== null) boundedText(result.correction_reason);
  const conflicts = digests(result.conflicts_with, 0, 16);
  if (parents.length + (supersedes === null ? 0 : 1) + conflicts.length > 128)
    fail("limit_exceeded");
  return {
    ...result,
    subject: subjectValue,
    derived_from: parents,
    supersedes,
    conflicts_with: conflicts,
  } as EvidencePayload;
}

function parseEnvelope(input: unknown, checkDigest: boolean): EvidenceEnvelope {
  canonicalJson(input);
  const result = strict(input, ["digest", "evidence"], ["digest", "evidence"]);
  const digest = text(result.digest, DIGEST);
  const evidence = payload(result.evidence);
  if (checkDigest && canonicalDigest("evidence", evidence) !== digest)
    fail("digest_mismatch");
  return { digest, evidence };
}
export function parseEvidenceEnvelope(input: unknown): EvidenceEnvelope {
  return parseEnvelope(input, true);
}
export function evidenceDigest(input: unknown): string {
  return canonicalDigest("evidence", payload(input));
}

type TopologyOptions = {
  allowExternalPublicLineage?: boolean;
};

function topology(
  graph: EvidenceGraph,
  options: TopologyOptions = {},
): Map<string, EvidenceEnvelope> {
  const allowExternalPublicLineage =
    options.allowExternalPublicLineage === true;
  const byDigest = new Map<string, EvidenceEnvelope>();
  for (const bundle of graph.bundles) {
    if (byDigest.has(bundle.digest)) {
      fail("invalid_lineage");
    }
    byDigest.set(bundle.digest, bundle);
  }

  const canReference = (source: Dict, target: Dict): boolean => {
    const sourceAccess = source.access as Dict;
    const targetAccess = target.access as Dict;
    if (sourceAccess.visibility === "public") {
      return targetAccess.visibility === "public";
    }
    if (targetAccess.visibility === "public") {
      return true;
    }
    return (
      canonicalJson(sourceAccess.owner) === canonicalJson(targetAccess.owner)
    );
  };

  const reachable = new Set<string>();
  const visitClosure = (digest: string): void => {
    const bundle = byDigest.get(digest);
    if (!bundle) {
      fail("evidence_unavailable");
    }
    if (reachable.has(digest)) {
      return;
    }
    reachable.add(digest);

    const evidence = bundle.evidence as Dict;
    const validateReference = (reference: string, derived: boolean): void => {
      if (reference === digest) {
        fail("invalid_lineage");
      }
      const target = byDigest.get(reference);
      if (!target) {
        if (allowExternalPublicLineage && !derived) {
          return;
        }
        fail("evidence_unavailable");
      }
      if (allowExternalPublicLineage && !derived) {
        fail("invalid_lineage");
      }
      if (!canReference(evidence, target.evidence as Dict)) {
        fail("invalid_lineage");
      }
      visitClosure(reference);
    };

    for (const reference of evidence.derived_from as string[]) {
      validateReference(reference, true);
    }
    if (evidence.supersedes !== null) {
      validateReference(evidence.supersedes as string, false);
    }
    for (const reference of evidence.conflicts_with as string[]) {
      validateReference(reference, false);
    }
  };

  for (const root of graph.roots) {
    visitClosure(root);
  }
  if (reachable.size !== byDigest.size) {
    fail("invalid_lineage");
  }

  const greatestDepth = new Map<string, number>();
  const active = new Set<string>();
  const visitDag = (digest: string, depth: number): void => {
    if (depth > 16) {
      fail("limit_exceeded");
    }
    if (active.has(digest)) {
      fail("invalid_lineage");
    }
    const previousDepth = greatestDepth.get(digest);
    if (previousDepth !== undefined && previousDepth >= depth) {
      return;
    }
    const bundle = byDigest.get(digest);
    if (!bundle) {
      fail("evidence_unavailable");
    }
    active.add(digest);

    const evidence = bundle.evidence as Dict;
    for (const parent of [
      ...(evidence.derived_from as string[]),
      ...(evidence.supersedes === null ? [] : [evidence.supersedes as string]),
    ]) {
      if (!byDigest.has(parent) && allowExternalPublicLineage) {
        continue;
      }
      visitDag(parent, depth + 1);
    }

    active.delete(digest);
    greatestDepth.set(digest, depth);
  };
  for (const root of graph.roots) {
    visitDag(root, 0);
  }
  for (const digest of reachable) {
    visitDag(digest, 0);
  }

  return byDigest;
}
export function parseEvidenceGraph(input: unknown): EvidenceGraph {
  return parseEvidenceGraphWithOptions(input);
}

export function parsePublicSubmissionEvidenceGraph(
  input: unknown,
): EvidenceGraph {
  return parseEvidenceGraphWithOptions(input, {
    allowExternalPublicLineage: true,
  });
}

function parseEvidenceGraphWithOptions(
  input: unknown,
  options: TopologyOptions = {},
): EvidenceGraph {
  canonicalJson(input);
  const result = strict(input, ["roots", "bundles"], ["roots", "bundles"]);
  const roots = digests(result.roots, 1);
  if (roots.length > 16) fail("limit_exceeded");
  const bundles = array(result.bundles, 64).map((item) =>
    parseEnvelope(item, false),
  );
  const graph = { roots, bundles };
  const byDigest = topology(graph, options);
  let references = 0;
  for (const bundle of bundles) {
    const evidence = bundle.evidence as Dict;
    const derived = evidence.derived_from as string[];
    const conflicts = evidence.conflicts_with as string[];
    references +=
      derived.length +
      (evidence.supersedes === null ? 0 : 1) +
      conflicts.length;
    if (references > 128) fail("limit_exceeded");
    for (const parent of derived) {
      if (
        ((byDigest.get(parent)!.evidence as Dict).subject as Dict).chain_id !==
        (evidence.subject as Dict).chain_id
      )
        fail("invalid_lineage");
    }
    if (
      evidence.supersedes !== null &&
      byDigest.has(evidence.supersedes as string)
    ) {
      const previous = byDigest.get(evidence.supersedes as string)!
        .evidence as Dict;
      if (
        canonicalJson(previous.subject) !== canonicalJson(evidence.subject) ||
        canonicalJson(previous.access) !== canonicalJson(evidence.access)
      )
        fail("invalid_lineage");
    }
    if (canonicalDigest("evidence", evidence) !== bundle.digest)
      fail("digest_mismatch");
  }
  return graph;
}
export function parseResultManifest(input: unknown): ResultManifest {
  canonicalJson(input);
  const result = strict(
    input,
    ["protocol", "schema_revision", "schema", "subject", "evidence_digests"],
    ["protocol", "schema_revision", "schema", "subject", "evidence_digests"],
  );
  if (
    result.protocol !== PROTOCOL_REVISION ||
    result.schema_revision !== SCHEMA_REVISION ||
    result.schema !== "gossip.result.v2"
  )
    fail("invalid_evidence");
  const roots = digests(result.evidence_digests, 1);
  if (roots.length > 16) fail("limit_exceeded");
  return {
    ...result,
    subject: subject(result.subject),
    evidence_digests: roots,
  } as ResultManifest;
}
export function resultDigest(input: unknown): string {
  return canonicalDigest("evidence", parseResultManifest(input));
}
export function validateResultPacket(
  packet: unknown,
  graph: unknown,
): ResultManifest {
  const manifest = parseResultManifest(packet);
  const parsed = parseEvidenceGraph(graph);
  if (canonicalJson(manifest.evidence_digests) !== canonicalJson(parsed.roots))
    fail("digest_mismatch");
  for (const root of parsed.roots) {
    const bundle = parsed.bundles.find(
      (candidate) => candidate.digest === root,
    );
    if (
      !bundle ||
      canonicalJson(bundle.evidence.subject) !== canonicalJson(manifest.subject)
    ) {
      fail("invalid_evidence");
    }
  }
  return manifest;
}

export function validatePublicSubmissionResultPacket(
  packet: unknown,
  graph: unknown,
): ResultManifest {
  const manifest = parseResultManifest(packet);
  const parsed = parsePublicSubmissionEvidenceGraph(graph);
  if (canonicalJson(manifest.evidence_digests) !== canonicalJson(parsed.roots))
    fail("digest_mismatch");
  for (const root of parsed.roots) {
    const bundle = parsed.bundles.find(
      (candidate) => candidate.digest === root,
    );
    if (
      !bundle ||
      canonicalJson(bundle.evidence.subject) !== canonicalJson(manifest.subject)
    ) {
      fail("invalid_evidence");
    }
  }
  return manifest;
}
export function assessEvidenceGraph(
  input: unknown,
  options: {
    now: number;
    max_age_seconds: number;
    finality: "latest" | "safe" | "finalized";
  },
): EvidenceAssessment {
  const assessmentOptions = strict(
    options,
    ["now", "max_age_seconds", "finality"],
    ["now", "max_age_seconds", "finality"],
  );
  const now = time(assessmentOptions.now);
  const maxAgeSeconds = assessmentOptions.max_age_seconds;
  const finality = assessmentOptions.finality;
  if (
    !Number.isSafeInteger(maxAgeSeconds) ||
    (maxAgeSeconds as number) < 0 ||
    (maxAgeSeconds as number) > 86400 ||
    typeof finality !== "string" ||
    !(["latest", "safe", "finalized"] as const).includes(finality as "latest")
  ) {
    fail("invalid_evidence");
  }
  const graph = parseEvidenceGraph(input);
  const byDigest = topology(graph);
  const reasons = new Set<string>();
  const assessed = new Set<string>();
  let oldest: number | null = null;
  const visit = (digest: string, lineage = new Set<string>()): void => {
    if (lineage.has(digest)) fail("invalid_lineage");
    if (assessed.has(digest)) return;
    assessed.add(digest);
    const evidence = byDigest.get(digest)!.evidence as Dict;
    const validity = evidence.validity as Dict;
    const window = validity.window as Dict;
    const end = window.end as number;
    oldest = oldest === null ? end : Math.min(oldest, end);
    if ((window.end as number) > now) reasons.add("future");
    if (validity.expires_at === null || now >= (validity.expires_at as number))
      reasons.add("expired");
    if (validity.type === "chain") {
      if (validity.canonicality !== "canonical") reasons.add("canonicality");
      if (
        validity.finality === "unknown" ||
        (finality === "safe" && validity.finality === "latest") ||
        (finality === "finalized" && validity.finality !== "finalized")
      )
        reasons.add("finality");
    } else {
      reasons.add("finality");
    }
    const next = new Set(lineage);
    next.add(digest);
    for (const parent of evidence.derived_from as string[]) visit(parent, next);
  };
  for (const root of graph.roots) visit(root);
  if (oldest !== null && now - oldest > (maxAgeSeconds as number))
    reasons.add("stale");
  return {
    valid: reasons.size === 0,
    reasons: [...reasons],
    oldest_validity_end: oldest,
  };
}
export const parseEvidence = parseEvidenceEnvelope;
export const parseEvidenceBundle = parseEvidenceGraph;
