import { z } from "zod";
import { getAddress } from "ethers";
import {
  capabilitiesSchema,
  consultationSchema,
  negotiateCapabilities,
  operationIdV2Schema,
  parseConsultation,
  type Capabilities,
} from "./protocol-v2.js";
import { parsePublicSubmission } from "./public-submission-v1.js";
import { validatePublicSubmissionReceipt } from "./public-submission-receipt-v1.js";
import { parseSignedReceipt } from "./receipts-v2.js";
import type { Connection } from "./transport.js";
import { canonicalJson } from "./canonical.js";

export interface V2Engine {
  call(tool: string, arguments_: Record<string, unknown>): Promise<unknown>;
  serverNowSeconds(): Promise<number>;
}

const operationSchema = z
  .object({
    protocol: z.literal("gossip/2-draft.1"),
    schema_revision: z.literal("2026-09-09"),
    schema: z.literal("gossip.operation.v2"),
    operation_id: operationIdV2Schema,
    status: z.string().min(1),
    economic_state: z.string().min(1),
    version: z.number().int().nonnegative(),
    reserved_amount: z.string().regex(/^(?:0|[1-9][0-9]*)$/),
    charged_amount: z
      .string()
      .regex(/^(?:0|[1-9][0-9]*)$/)
      .nullable()
      .optional(),
    result_canonical: z.string().nullable().optional(),
    result_digest: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/)
      .nullable()
      .optional(),
    unmet_requirements: z.array(z.string()),
    rejection_reason: z.string().nullable().optional(),
  })
  .passthrough();

const receiptCollectionSchema = z
  .object({ receipts: z.array(z.unknown()).min(1).max(256) })
  .strict();

function canonicalWireRequest<T>(request: T): T {
  return JSON.parse(canonicalJson(request)) as T;
}

export class GossipV2Kit {
  readonly address: string;

  constructor(
    _directory: string,
    address: string,
    private readonly engine: V2Engine,
    private readonly connection: Pick<Connection, "endpoint" | "audience">,
  ) {
    this.address = getAddress(address).toLowerCase();
  }

  async capabilities(): Promise<Capabilities> {
    const report = capabilitiesSchema.parse(
      await this.engine.call("gossip_capabilities", {}),
    );
    negotiateCapabilities(
      report,
      {
        endpoint: this.connection.endpoint,
        audience: this.connection.audience,
        mcp_revision: "2025-11-25",
        auth_profile: "gossip-eip191-v2",
      },
      await this.engine.serverNowSeconds(),
    );
    return report;
  }

  async access(): Promise<Capabilities> {
    return this.capabilities();
  }

  async consult(request: unknown): Promise<Record<string, unknown>> {
    const parsed = parseConsultation(
      request,
      await this.engine.serverNowSeconds(),
    );
    this.assertOwnerAndConnection(
      parsed.actor,
      parsed.endpoint,
      parsed.audience,
    );
    const wireRequest = canonicalWireRequest(parsed);
    const response = operationSchema.parse(
      await this.engine.call("gossip_consult_v2", { request: wireRequest }),
    );
    this.assertOperation(response, parsed.operation_id);
    return response as Record<string, unknown>;
  }

  async submit(request: unknown): Promise<unknown> {
    const parsed = parsePublicSubmission(request);
    this.assertOwnerAndConnection(
      parsed.actor,
      parsed.endpoint,
      parsed.audience,
    );
    const wireRequest = canonicalWireRequest(parsed);
    const response = await this.engine.call("gossip_submit_v2", {
      request: wireRequest,
    });
    return validatePublicSubmissionReceipt(response, parsed);
  }

  async operation(operationId: string): Promise<Record<string, unknown>> {
    const parsed = operationIdV2Schema.parse(operationId);
    const response = operationSchema.parse(
      await this.engine.call("gossip_operation", { operation_id: parsed }),
    );
    this.assertOperation(response, parsed);
    return response as Record<string, unknown>;
  }

  async receipt(operationId: string): Promise<unknown> {
    const parsed = operationIdV2Schema.parse(operationId);
    const collection = receiptCollectionSchema.parse(
      await this.engine.call("gossip_receipt_v2", { operation_id: parsed }),
    );
    const receipts = collection.receipts.map((receipt) =>
      parseSignedReceipt(receipt),
    );
    if (receipts.some((receipt) => receipt.receipt.operation_id !== parsed)) {
      throw new Error("Gossip v2 receipt response is for another operation.");
    }
    return { receipts };
  }

  async feedback(_request: unknown): Promise<never> {
    throw new Error("Gossip v2 feedback is unavailable.");
  }

  close(): void {}

  private assertOwnerAndConnection(
    actor: { address: string; chain_id: string },
    endpoint: string,
    audience: string,
  ): void {
    if (
      actor.chain_id !== "4663" ||
      actor.address !== this.address ||
      endpoint !== this.connection.endpoint ||
      audience !== this.connection.audience
    ) {
      throw new Error("Gossip v2 request is outside the configured identity.");
    }
  }

  private assertOperation(
    response: { operation_id: string },
    operationId: string,
  ): void {
    if (response.operation_id !== operationId) {
      throw new Error("Gossip v2 operation response is for another operation.");
    }
  }
}
