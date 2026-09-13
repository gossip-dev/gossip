import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAddress, isAddress } from "ethers";
import { z } from "zod";
import { withTradeLock, writeTradeFile } from "./trade-state.js";

const POLICY_FILE = "trade-autonomy.json";
const MODE_FILE = "trade-mode.json";
const USAGE_FILE = "trade-autonomy-usage.json";
const MAX_STATE_BYTES = 1024 * 1024;

const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const uintSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,77})$/)
  .refine((value) => BigInt(value) < 2n ** 256n);
const positiveUintSchema = uintSchema.refine((value) => BigInt(value) > 0n);
const addressSchema = z
  .string()
  .refine((value) => isAddress(value), "must be a valid EVM address")
  .transform((value) => getAddress(value));
const feeSchema = z.union([
  z.literal(100),
  z.literal(500),
  z.literal(3000),
  z.literal(10000),
]);
const actionKindSchema = z.enum(["quick-buy", "dca", "watcher"]);

export const autonomyProposalSchema = z
  .object({
    id: idSchema,
    account: addressSchema,
    inputToken: addressSchema,
    outputTokens: z.array(addressSchema).min(1).max(64),
    actionKinds: z.array(actionKindSchema).min(1).max(3),
    maxInputPerTrade: positiveUintSchema,
    maxInputPerUtcDay: positiveUintSchema,
    maxInputTotal: positiveUintSchema,
    maxTradesPerUtcDay: z.number().int().min(1).max(10_000),
    maxExecutions: z.number().int().min(1).max(1_000_000),
    maxInputBalanceBps: z.number().int().min(1).max(10_000),
    maxSlippageBps: z.number().int().min(0).max(9_999),
    gasLimit: positiveUintSchema,
    maxFeePerGas: positiveUintSchema,
    maxPriorityFeePerGas: positiveUintSchema,
    maxGasCostPerTrade: positiveUintSchema,
    maxGasCostPerUtcDay: positiveUintSchema,
    maxDeadlineSeconds: z.number().int().min(1).max(300),
    minNativeReserveWei: uintSchema,
    feeTiers: z.array(feeSchema).min(1).max(4),
    validUntil: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .superRefine((proposal, context) => {
    if (proposal.outputTokens.includes(proposal.inputToken)) {
      context.addIssue({
        code: "custom",
        path: ["outputTokens"],
        message: "output token must differ from input token",
      });
    }
    if (
      new Set(proposal.outputTokens).size !== proposal.outputTokens.length ||
      new Set(proposal.actionKinds).size !== proposal.actionKinds.length ||
      new Set(proposal.feeTiers).size !== proposal.feeTiers.length
    ) {
      context.addIssue({
        code: "custom",
        message: "policy lists must not contain duplicates",
      });
    }
  });

export const autonomyPolicySchema = autonomyProposalSchema.extend({
  schemaVersion: z.literal(1),
  mode: z.literal("bounded-auto"),
  chainId: z.literal("4663"),
  enabled: z.boolean(),
  revision: z.number().int().positive(),
  createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  activatedAt: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .nullable(),
  revokedAt: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .nullable(),
});

const autonomousRequestSchema = z
  .object({
    id: idSchema,
    policyId: idSchema,
    actionKind: actionKindSchema,
    account: addressSchema,
    tokenIn: addressSchema,
    tokenOut: addressSchema,
    amountIn: positiveUintSchema,
    inputBalance: uintSchema,
    fee: feeSchema,
    slippageBps: z.number().int().min(0).max(9_999),
    deadlineSeconds: z.number().int().min(1).max(300),
    gasLimit: positiveUintSchema,
    maxFeePerGas: positiveUintSchema,
    maxPriorityFeePerGas: positiveUintSchema,
  })
  .strict();

const reservationSchema = z
  .object({
    id: idSchema,
    policyId: idSchema,
    policyRevision: z.number().int().positive(),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    amountIn: positiveUintSchema,
    worstCaseGas: positiveUintSchema,
    utcDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
const usageSchema = z
  .object({
    schemaVersion: z.literal(1),
    reservations: z.array(reservationSchema).max(100_000),
  })
  .strict();
const modeSchema = z
  .object({
    schemaVersion: z.literal(1),
    mode: z.literal("confirm-each"),
    selectedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export type AutonomyProposal = z.input<typeof autonomyProposalSchema>;
export type AutonomyPolicy = z.output<typeof autonomyPolicySchema>;
export type AutonomousRequest = z.input<typeof autonomousRequestSchema>;
export type AutonomyReservation = z.output<typeof reservationSchema>;

export async function readActiveAutonomyPolicy(
  directory: string,
  now = Math.floor(Date.now() / 1000),
): Promise<AutonomyPolicy> {
  const policy = await readPolicy(directory);
  if (
    !policy.enabled ||
    policy.activatedAt === null ||
    policy.validUntil <= now
  ) {
    throw new Error("Autonomy policy is not active");
  }
  return policy;
}

export async function proposeAutonomy(
  directory: string,
  input: AutonomyProposal,
  now = Math.floor(Date.now() / 1000),
): Promise<AutonomyPolicy> {
  const proposal = autonomyProposalSchema.parse(input);
  if (proposal.validUntil <= now) {
    throw new Error("Autonomy proposal is already expired");
  }

  return withTradeLock(directory, async () => {
    const existing = await readPolicyIfPresent(directory);
    if (existing?.enabled) {
      throw new Error("Active autonomy must be revoked before replacement");
    }
    const policy = autonomyPolicySchema.parse({
      schemaVersion: 1,
      mode: "bounded-auto",
      chainId: "4663",
      enabled: false,
      revision: (existing?.revision ?? 0) + 1,
      createdAt: now,
      activatedAt: null,
      revokedAt: null,
      ...proposal,
    });
    await writeTradeFile(directory, POLICY_FILE, policy);
    return policy;
  });
}

export async function chooseConfirmEach(
  directory: string,
  now = Math.floor(Date.now() / 1000),
): Promise<void> {
  await withTradeLock(directory, async () => {
    const policy = await readPolicyIfPresent(directory);
    if (policy?.enabled) {
      throw new Error("Active autonomy must be revoked before changing mode");
    }
    await writeTradeFile(directory, MODE_FILE, {
      schemaVersion: 1,
      mode: "confirm-each",
      selectedAt: now,
    });
  });
}

export async function activateAutonomyProposal(
  directory: string,
  id: string,
  account: string,
  now = Math.floor(Date.now() / 1000),
): Promise<AutonomyPolicy> {
  return withTradeLock(directory, async () => {
    const policy = await readPolicy(directory);
    if (policy.id !== idSchema.parse(id)) {
      throw new Error("Autonomy proposal ID does not match");
    }
    if (policy.account !== addressSchema.parse(account)) {
      throw new Error("Autonomy proposal account does not match wallet");
    }
    if (policy.enabled || policy.revokedAt !== null) {
      throw new Error("Autonomy proposal cannot be activated");
    }
    if (policy.validUntil <= now) {
      throw new Error("Autonomy proposal is expired");
    }
    const active = autonomyPolicySchema.parse({
      ...policy,
      enabled: true,
      activatedAt: now,
    });
    await writeTradeFile(directory, POLICY_FILE, active);
    return active;
  });
}

export async function revokeAutonomy(
  directory: string,
  now = Math.floor(Date.now() / 1000),
): Promise<AutonomyPolicy> {
  return withTradeLock(directory, async () => {
    const policy = await readPolicy(directory);
    if (!policy.enabled) return policy;
    const revoked = autonomyPolicySchema.parse({
      ...policy,
      enabled: false,
      revokedAt: now,
    });
    await writeTradeFile(directory, POLICY_FILE, revoked);
    return revoked;
  });
}

export async function readAutonomyStatus(directory: string): Promise<
  | {
      mode: "choice-required";
      executionAuthorized: false;
      proposedPolicy?: AutonomyPolicy;
    }
  | {
      mode: "confirm-each";
      executionAuthorized: false;
      proposedPolicy?: AutonomyPolicy;
    }
  | {
      mode: "bounded-auto";
      executionAuthorized: boolean;
      policy: AutonomyPolicy;
    }
> {
  const policy = await readPolicyIfPresent(directory);
  if (!policy || policy.activatedAt === null) {
    try {
      modeSchema.parse(
        JSON.parse(await readBoundedFile(join(directory, MODE_FILE))),
      );
      return {
        mode: "confirm-each",
        executionAuthorized: false,
        ...(policy ? { proposedPolicy: policy } : {}),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return {
        mode: "choice-required",
        executionAuthorized: false,
        ...(policy ? { proposedPolicy: policy } : {}),
      };
    }
  }
  return {
    mode: "bounded-auto",
    executionAuthorized:
      policy.enabled && policy.validUntil > Math.floor(Date.now() / 1000),
    policy,
  };
}

export async function authorizeAutonomousRequest(
  directory: string,
  input: AutonomousRequest,
  now = Math.floor(Date.now() / 1000),
): Promise<AutonomyReservation> {
  const request = autonomousRequestSchema.parse(input);

  return withTradeLock(directory, async () => {
    const policy = await readPolicy(directory);
    assertRequestWithinPolicy(policy, request, now);
    const usage = await readUsage(directory);
    const fingerprint = requestFingerprint(request, policy.revision);
    const existing = usage.reservations.find(
      (reservation) => reservation.id === request.id,
    );
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new Error("Autonomous operation ID already has another request");
      }
      return existing;
    }

    const utcDay = new Date(now * 1000).toISOString().slice(0, 10);
    const today = usage.reservations.filter(
      (reservation) =>
        reservation.policyId === policy.id &&
        reservation.policyRevision === policy.revision &&
        reservation.utcDay === utcDay,
    );
    if (today.length >= policy.maxTradesPerUtcDay) {
      throw new Error("Autonomy daily trade count is exhausted");
    }
    const lifetime = usage.reservations.filter(
      (reservation) =>
        reservation.policyId === policy.id &&
        reservation.policyRevision === policy.revision,
    );
    if (lifetime.length >= policy.maxExecutions) {
      throw new Error("Autonomy execution count is exhausted");
    }
    const dailyInput = today.reduce(
      (total, reservation) => total + BigInt(reservation.amountIn),
      0n,
    );
    if (
      dailyInput + BigInt(request.amountIn) >
      BigInt(policy.maxInputPerUtcDay)
    ) {
      throw new Error("Autonomy daily input budget is exhausted");
    }
    const lifetimeInput = lifetime.reduce(
      (total, reservation) => total + BigInt(reservation.amountIn),
      0n,
    );
    if (
      lifetimeInput + BigInt(request.amountIn) >
      BigInt(policy.maxInputTotal)
    ) {
      throw new Error("Autonomy total input budget is exhausted");
    }
    const worstCaseGas =
      2n * BigInt(request.gasLimit) * BigInt(request.maxFeePerGas);
    if (worstCaseGas > BigInt(policy.maxGasCostPerTrade)) {
      throw new Error("Autonomy per-trade gas budget exceeded");
    }
    const dailyGas = today.reduce(
      (total, reservation) => total + BigInt(reservation.worstCaseGas),
      0n,
    );
    if (dailyGas + worstCaseGas > BigInt(policy.maxGasCostPerUtcDay)) {
      throw new Error("Autonomy daily gas budget is exhausted");
    }

    const reservation = reservationSchema.parse({
      id: request.id,
      policyId: policy.id,
      policyRevision: policy.revision,
      fingerprint,
      amountIn: request.amountIn,
      worstCaseGas: worstCaseGas.toString(),
      utcDay,
      createdAt: now,
    });
    usage.reservations.push(reservation);
    await writeTradeFile(directory, USAGE_FILE, usage);
    return reservation;
  });
}

export async function assertActiveAutonomyReservation(
  directory: string,
  reservation: Pick<
    AutonomyReservation,
    "id" | "policyId" | "policyRevision" | "fingerprint"
  >,
  now = Math.floor(Date.now() / 1000),
): Promise<void> {
  const policy = await readPolicy(directory);
  if (
    !policy.enabled ||
    policy.validUntil <= now ||
    policy.id !== reservation.policyId ||
    policy.revision !== reservation.policyRevision
  ) {
    throw new Error("Autonomy authorization changed or expired");
  }
  const usage = await readUsage(directory);
  const stored = usage.reservations.find(
    (candidate) => candidate.id === reservation.id,
  );
  if (!stored || stored.fingerprint !== reservation.fingerprint) {
    throw new Error("Autonomy reservation is unavailable");
  }
}

function assertRequestWithinPolicy(
  policy: AutonomyPolicy,
  request: z.output<typeof autonomousRequestSchema>,
  now: number,
): void {
  if (
    !policy.enabled ||
    policy.activatedAt === null ||
    policy.validUntil <= now
  ) {
    throw new Error("Autonomy policy is not active");
  }
  if (policy.id !== request.policyId) {
    throw new Error("Autonomy policy ID does not match");
  }
  if (policy.account !== request.account) {
    throw new Error("Autonomy account does not match");
  }
  if (policy.inputToken !== request.tokenIn) {
    throw new Error("Autonomy input token is not allowed");
  }
  if (!policy.outputTokens.includes(request.tokenOut)) {
    throw new Error("Autonomy output token is not allowed");
  }
  if (!policy.actionKinds.includes(request.actionKind)) {
    throw new Error("Autonomy action kind is not allowed");
  }
  if (!policy.feeTiers.includes(request.fee)) {
    throw new Error("Autonomy fee tier is not allowed");
  }
  if (request.slippageBps > policy.maxSlippageBps) {
    throw new Error("Autonomy slippage limit exceeded");
  }
  if (request.deadlineSeconds > policy.maxDeadlineSeconds) {
    throw new Error("Autonomy quote deadline exceeded");
  }
  if (BigInt(request.gasLimit) > BigInt(policy.gasLimit)) {
    throw new Error("Autonomy gas limit exceeded");
  }
  if (BigInt(request.maxFeePerGas) > BigInt(policy.maxFeePerGas)) {
    throw new Error("Autonomy maximum fee exceeded");
  }
  if (
    BigInt(request.maxPriorityFeePerGas) > BigInt(policy.maxPriorityFeePerGas)
  ) {
    throw new Error("Autonomy priority fee exceeded");
  }
  if (BigInt(request.amountIn) > BigInt(policy.maxInputPerTrade)) {
    throw new Error("Autonomy per-trade limit exceeded");
  }
  if (
    BigInt(request.amountIn) * 10_000n >
    BigInt(request.inputBalance) * BigInt(policy.maxInputBalanceBps)
  ) {
    throw new Error("Autonomy balance percentage limit exceeded");
  }
}

async function readPolicy(directory: string): Promise<AutonomyPolicy> {
  return autonomyPolicySchema.parse(
    JSON.parse(await readBoundedFile(join(directory, POLICY_FILE))),
  );
}

async function readPolicyIfPresent(
  directory: string,
): Promise<AutonomyPolicy | null> {
  try {
    return await readPolicy(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function readUsage(directory: string) {
  try {
    return usageSchema.parse(
      JSON.parse(await readBoundedFile(join(directory, USAGE_FILE))),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return usageSchema.parse({ schemaVersion: 1, reservations: [] });
    }
    throw error;
  }
}

async function readBoundedFile(path: string): Promise<string> {
  const text = await readFile(path, "utf8");
  if (Buffer.byteLength(text, "utf8") > MAX_STATE_BYTES) {
    throw new Error("Trade autonomy state exceeds limit");
  }
  return text;
}

function requestFingerprint(
  request: z.output<typeof autonomousRequestSchema>,
  policyRevision: number,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ policyRevision, request }))
    .digest("hex");
}
