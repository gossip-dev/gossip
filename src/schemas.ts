import { z } from "zod";

export const operationId = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
export const gossipKinds = [
  "token_discovery",
  "pool_discovery",
  "external_event",
  "trading_experience",
] as const;
export const submissionSchema = z
  .object({
    schema_version: z.literal(1),
    client_id: operationId,
    chain_id: z.literal(4663),
    subject: z.string().regex(/^0x(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/),
    kind: z.enum(gossipKinds),
    observed_at: z.iso.datetime({ offset: true }),
    provenance: z.enum(["observed", "relayed", "inferred"]),
    source: z.url().max(512).optional(),
    claim: z.string().min(1).max(2000).optional(),
    transaction_hash: z
      .string()
      .regex(/^0x[0-9a-fA-F]{64}$/)
      .optional(),
    follows_receipt_id: z.uuid().optional(),
    follow_up_kind: z.enum(["evidence", "correction"]).optional(),
  })
  .strict();
export const policySchema = z
  .object({
    dailyCreditBudget: z.number().int().nonnegative().max(1000),
    submissionKinds: z.array(z.enum(gossipKinds)).max(4),
  })
  .strict();
