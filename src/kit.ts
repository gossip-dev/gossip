import { operationId, submissionSchema, policySchema } from "./schemas.js";
import { OperationJournal } from "./operations.js";
import { getAddress } from "ethers";
import { z } from "zod";

export interface Engine {
  call(tool: string, arguments_: Record<string, unknown>): Promise<unknown>;
}
export interface Policy {
  dailyCreditBudget: number;
  submissionKinds: string[];
}
const accessSchema = z.object({
  wallet: z.string(),
  standard_remaining: z.number().int().nonnegative(),
  enriched_remaining: z.number().int().nonnegative(),
  monetary_enabled: z.literal(false),
});

const receiptSchema = z
  .object({ id: z.uuid(), client_id: operationId, status: z.string().min(1) })
  .passthrough();

export class GossipKit {
  private readonly operations: OperationJournal;
  constructor(
    directory: string,
    private address: string,
    private engine: Engine,
    private policy: Policy,
  ) {
    this.policy = policySchema.parse(policy);
    this.operations = new OperationJournal(directory, getAddress(address));
  }
  async access() {
    const parsed = accessSchema.safeParse(
      await this.engine.call("agent_access", {}),
    );
    if (
      !parsed.success ||
      getAddress(parsed.data.wallet) !== getAddress(this.address)
    )
      throw new Error("Invalid engine access response.");
    return parsed.data;
  }
  async consult(
    clientId: string,
    token: string,
  ): Promise<Record<string, unknown>> {
    operationId.parse(clientId);
    const args = {
      client_id: clientId,
      token: getAddress(token).toLowerCase(),
    };
    const cached = this.operations.begin(
      clientId,
      "agent_consult",
      args,
      this.policy.dailyCreditBudget,
    );
    if (cached !== undefined) return cached as Record<string, unknown>;
    const result = await this.engine.call("agent_consult", args);
    const parsed = z
      .object({
        client_id: z.literal(clientId),
        tier: z.enum(["standard", "enriched"]),
        analysis: z.unknown(),
      })
      .passthrough()
      .safeParse(result);
    if (!parsed.success)
      throw new Error(
        "Invalid consultation response; operation remains pending.",
      );
    this.operations.complete(clientId, parsed.data);
    return parsed.data;
  }
  async submit(input: unknown): Promise<unknown> {
    const submission = submissionSchema.parse(input);
    if (!this.policy.submissionKinds.includes(submission.kind))
      throw new Error(
        "Submission permission is required for this kind of Gossip.",
      );
    const args = { submission };
    const cached = this.operations.begin(
      submission.client_id,
      "gossip_submit",
      args,
      null,
    );
    if (cached !== undefined) return cached;
    const result = await this.engine.call("gossip_submit", args);
    const parsed = receiptSchema.safeParse(result);
    if (!parsed.success || parsed.data.client_id !== submission.client_id)
      throw new Error("Invalid receipt response; operation remains pending.");
    this.operations.complete(submission.client_id, result);
    return result;
  }
  async receipt(receiptId: string): Promise<unknown> {
    const result = receiptSchema.safeParse(
      await this.engine.call("gossip_receipt", {
        receipt_id: z.uuid().parse(receiptId),
      }),
    );
    if (
      !result.success ||
      result.data.id.toLowerCase() !== receiptId.toLowerCase()
    )
      throw new Error("Invalid receipt response.");
    return result.data;
  }
  close() {
    this.operations.close();
  }
}
