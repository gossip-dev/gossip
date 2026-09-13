import { canonicalDigest, canonicalJson } from "./canonical.js";
import {
  evidenceDigest,
  parseEvidenceEnvelope,
  type EvidencePayload,
} from "./evidence-v2.js";
import { PROTOCOL_REVISION } from "./protocol-v2.js";
import { ProtocolError } from "./protocol-errors.js";

export const PUBLIC_EVIDENCE_DOCUMENT_SCHEMA =
  "gossip.public-evidence-document.v1" as const;
export const PUBLIC_EVIDENCE_DOCUMENT_SCHEMA_REVISION = "2026-09-11" as const;

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const MAX_LINKS = 256;
const RELATIONSHIPS = ["derived_from", "supersedes", "conflicts_with"] as const;

export type PublicEvidenceRelationship = (typeof RELATIONSHIPS)[number];

export type PublicEvidenceLink = {
  child_digest: string;
  relationship: PublicEvidenceRelationship;
  parent_digest: string;
  correction_reason: string | null;
};

export type PublicEvidenceDocument = {
  protocol: typeof PROTOCOL_REVISION;
  schema_revision: typeof PUBLIC_EVIDENCE_DOCUMENT_SCHEMA_REVISION;
  schema: typeof PUBLIC_EVIDENCE_DOCUMENT_SCHEMA;
  digest: string;
  evidence: EvidencePayload;
  links: PublicEvidenceLink[];
};

type Dictionary = Record<string, unknown>;

function fail(code: ProtocolError["code"]): never {
  throw new ProtocolError(code);
}

function dictionary(value: unknown): Dictionary {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("invalid_request");
  }

  return value as Dictionary;
}

function exactObject(
  value: unknown,
  fields: readonly string[],
  code: ProtocolError["code"] = "invalid_request",
): Dictionary {
  const result = dictionary(value);
  const actual = Object.keys(result).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  ) {
    fail(code);
  }

  return result;
}

function text(value: unknown, code: ProtocolError["code"]): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(code);
  }

  return value;
}

function digest(value: unknown): string {
  const result = text(value, "invalid_lineage");
  if (!DIGEST.test(result)) {
    fail("invalid_lineage");
  }

  return result;
}

function validatePublicEvidence(evidence: EvidencePayload): void {
  if (evidence.access.visibility !== "public") {
    fail("invalid_lineage");
  }

  if (
    evidence.sources.some((source) => source.location.visibility !== "public")
  ) {
    fail("invalid_evidence");
  }
}

function correctionReason(
  value: unknown,
  relationship: PublicEvidenceRelationship,
): string | null {
  if (relationship === "supersedes") {
    const reason = text(value, "invalid_lineage");
    if (Array.from(reason).length > 256) {
      fail("invalid_lineage");
    }

    return reason;
  }

  if (value !== null) {
    fail("invalid_lineage");
  }

  return null;
}

function parseLink(value: unknown): PublicEvidenceLink {
  const link = exactObject(
    value,
    ["child_digest", "relationship", "parent_digest", "correction_reason"],
    "invalid_lineage",
  );
  const relationship = text(link.relationship, "invalid_lineage");
  if (!(RELATIONSHIPS as readonly string[]).includes(relationship)) {
    fail("invalid_lineage");
  }

  return {
    child_digest: digest(link.child_digest),
    relationship: relationship as PublicEvidenceRelationship,
    parent_digest: digest(link.parent_digest),
    correction_reason: correctionReason(
      link.correction_reason,
      relationship as PublicEvidenceRelationship,
    ),
  };
}

function validateLinks(
  links: PublicEvidenceLink[],
  requestedDigest: string,
  evidence: EvidencePayload,
): void {
  const references = new Map<PublicEvidenceRelationship, Set<string>>([
    ["derived_from", new Set(evidence.derived_from)],
    [
      "supersedes",
      evidence.supersedes === null ? new Set() : new Set([evidence.supersedes]),
    ],
    ["conflicts_with", new Set(evidence.conflicts_with)],
  ]);
  let previousKey: string | null = null;
  const outgoingLinks = new Set<string>();
  const expectedOutgoingLinks = new Set<string>();

  for (const [relationship, referencesForRelationship] of references) {
    for (const parentDigest of referencesForRelationship) {
      expectedOutgoingLinks.add(
        `${requestedDigest}\u0000${relationship}\u0000${parentDigest}`,
      );
    }
  }

  for (const link of links) {
    if (link.child_digest === link.parent_digest) {
      fail("invalid_lineage");
    }

    const key = `${link.child_digest}\u0000${link.relationship}\u0000${link.parent_digest}`;
    if (previousKey !== null && key <= previousKey) {
      fail("invalid_lineage");
    }
    previousKey = key;

    const includesRequestedDigest =
      link.child_digest === requestedDigest ||
      link.parent_digest === requestedDigest;
    if (!includesRequestedDigest) {
      fail("invalid_lineage");
    }

    if (link.child_digest === requestedDigest) {
      outgoingLinks.add(key);
      const relationshipReferences = references.get(link.relationship)!;
      if (!relationshipReferences.has(link.parent_digest)) {
        fail("invalid_lineage");
      }
      if (
        link.relationship === "supersedes" &&
        link.correction_reason !== evidence.correction_reason
      ) {
        fail("invalid_lineage");
      }
    }
  }

  if (
    outgoingLinks.size !== expectedOutgoingLinks.size ||
    [...outgoingLinks].some((key) => !expectedOutgoingLinks.has(key))
  ) {
    fail("invalid_lineage");
  }
}

export function parsePublicEvidenceDocument(
  input: unknown,
): PublicEvidenceDocument {
  canonicalJson(input);
  const document = exactObject(input, [
    "protocol",
    "schema_revision",
    "schema",
    "digest",
    "evidence",
    "links",
  ]);
  if (
    document.protocol !== PROTOCOL_REVISION ||
    document.schema_revision !== PUBLIC_EVIDENCE_DOCUMENT_SCHEMA_REVISION ||
    document.schema !== PUBLIC_EVIDENCE_DOCUMENT_SCHEMA
  ) {
    fail("unsupported_version");
  }

  const requestedDigest = digest(document.digest);
  const parsedEnvelope = parseEvidenceEnvelope({
    digest: requestedDigest,
    evidence: document.evidence,
  });
  if (evidenceDigest(parsedEnvelope.evidence) !== requestedDigest) {
    fail("digest_mismatch");
  }
  validatePublicEvidence(parsedEnvelope.evidence);

  if (!Array.isArray(document.links)) {
    fail("invalid_lineage");
  }
  if (document.links.length > MAX_LINKS) {
    fail("limit_exceeded");
  }
  const links = document.links.map(parseLink);
  validateLinks(links, requestedDigest, parsedEnvelope.evidence);

  return {
    protocol: PROTOCOL_REVISION,
    schema_revision: PUBLIC_EVIDENCE_DOCUMENT_SCHEMA_REVISION,
    schema: PUBLIC_EVIDENCE_DOCUMENT_SCHEMA,
    digest: requestedDigest,
    evidence: parsedEnvelope.evidence,
    links,
  };
}

export function publicEvidenceDocumentDigest(input: unknown): string {
  const parsed = parsePublicEvidenceDocument(input);
  return canonicalDigest("evidence", parsed.evidence);
}
