import { z } from "zod";
import { canonicalDigest, canonicalJson } from "./canonical.js";
import {
  actorSchema,
  AUTH_PROFILE,
  canonicalHttpsUrlSchema,
  operationIdV2Schema,
  PROTOCOL_REVISION,
  maxCostSchema,
} from "./protocol-v2.js";
import { ProtocolError } from "./protocol-errors.js";
import {
  parsePublicSubmissionEvidenceGraph,
  parseResultManifest,
  validatePublicSubmissionResultPacket,
  type EvidenceGraph,
  type ResultManifest,
} from "./evidence-v2.js";

export const PUBLIC_SUBMISSION_SCHEMA = "gossip.public-submission.v1" as const;
export const PUBLIC_SUBMISSION_SCHEMA_REVISION = "2026-09-11" as const;
export const PUBLIC_SUBMISSION_KIND = "public_submission" as const;

export const publicSubmissionSchema = z
  .object({
    protocol: z.literal(PROTOCOL_REVISION),
    schema_revision: z.literal(PUBLIC_SUBMISSION_SCHEMA_REVISION),
    schema: z.literal(PUBLIC_SUBMISSION_SCHEMA),
    auth_profile: z.literal(AUTH_PROFILE),
    operation_kind: z.literal(PUBLIC_SUBMISSION_KIND),
    operation_id: operationIdV2Schema,
    actor: actorSchema,
    endpoint: canonicalHttpsUrlSchema,
    audience: canonicalHttpsUrlSchema,
    max_cost: maxCostSchema,
    result: z.unknown(),
    evidence: z.unknown(),
  })
  .strict();

export type PublicSubmission = Omit<
  z.infer<typeof publicSubmissionSchema>,
  "result" | "evidence"
> & {
  result: ResultManifest;
  evidence: EvidenceGraph;
};

function invalidRequest(): never {
  throw new ProtocolError("invalid_request");
}

function validatePublicEvidence(graph: EvidenceGraph): void {
  const byDigest = new Map(
    graph.bundles.map((bundle) => [bundle.digest, bundle.evidence]),
  );

  for (const bundle of graph.bundles) {
    if (bundle.evidence.access.visibility !== "public") {
      throw new ProtocolError("invalid_lineage");
    }

    for (const source of bundle.evidence.sources) {
      if (source.location.visibility !== "public") {
        throw new ProtocolError("invalid_evidence");
      }
    }

    for (const conflictDigest of bundle.evidence.conflicts_with) {
      if (byDigest.has(conflictDigest)) {
        throw new ProtocolError("invalid_lineage");
      }
    }
  }
}

export function parsePublicSubmission(input: unknown): PublicSubmission {
  try {
    canonicalJson(input);
  } catch (error) {
    if (error instanceof ProtocolError) {
      throw error;
    }

    invalidRequest();
  }

  const parsed = publicSubmissionSchema.safeParse(input);
  if (!parsed.success || parsed.data.max_cost.amount !== "0") {
    invalidRequest();
  }

  const result = parseResultManifest(parsed.data.result);
  const evidence = parsePublicSubmissionEvidenceGraph(parsed.data.evidence);
  validatePublicSubmissionResultPacket(result, evidence);
  validatePublicEvidence(evidence);

  return {
    ...parsed.data,
    result,
    evidence,
  };
}

export function publicSubmissionDigest(input: unknown): string {
  return canonicalDigest("request", parsePublicSubmission(input));
}
