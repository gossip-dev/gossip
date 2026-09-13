import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAddress, isAddress } from "ethers";
import { z } from "zod";
import { withTradeLock, writeTradeFile } from "./trade-state.js";

const STRATEGIES_FILE = "trade-strategies.json";
const MAX_STRATEGIES_BYTES = 1024 * 1024;
const MAX_STRATEGIES = 10_000;
const MAX_OCCURRENCES = 10_000;

const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,52}$/);
const occurrenceIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{1,52}_run_[0-9]{6}$/);
const uintSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,77})$/)
  .refine((value) => BigInt(value) < 2n ** 256n, "must fit uint256");
const positiveUintSchema = uintSchema.refine(
  (value) => BigInt(value) > 0n,
  "must be positive",
);
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
const statusSchema = z.enum([
  "active",
  "paused",
  "cancelled",
  "blocked",
  "completed",
]);
const timestampSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const intervalSchema = z
  .number()
  .int()
  .min(60)
  .max(31 * 24 * 60 * 60);
const thresholdSchema = z
  .object({
    comparison: z.enum(["at-or-above", "at-or-below"]),
    amountOut: positiveUintSchema,
  })
  .strict();
const strategyAuthorizationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("confirm-each") }).strict(),
  z
    .object({
      kind: z.literal("standing-envelope"),
      policyId: idSchema,
      policyRevision: z.number().int().positive(),
    })
    .strict(),
]);

const commonInputSchema = z
  .object({
    id: idSchema,
    account: addressSchema,
    inputKind: z.enum(["erc20", "native"]).optional(),
    tokenIn: addressSchema,
    tokenOut: addressSchema,
    fee: feeSchema,
    slippageBps: z.number().int().min(0).max(9_999),
    authorization: strategyAuthorizationSchema,
  })
  .strict()
  .superRefine((strategy, context) => {
    if (strategy.tokenIn === strategy.tokenOut) {
      context.addIssue({
        code: "custom",
        path: ["tokenOut"],
        message: "tokenOut must differ from tokenIn",
      });
    }
  });

export const watcherInputSchema = commonInputSchema
  .extend({
    kind: z.literal("watcher"),
    amountIn: positiveUintSchema.optional(),
    threshold: thresholdSchema,
    pollIntervalSeconds: intervalSchema,
    maxRuns: z.number().int().min(1).max(MAX_OCCURRENCES).nullable(),
  })
  .strict();

export const dcaInputSchema = commonInputSchema
  .extend({
    kind: z.literal("dca"),
    amountIn: positiveUintSchema,
    anchorAt: timestampSchema,
    intervalSeconds: intervalSchema,
    maxRuns: z.number().int().min(1).max(MAX_OCCURRENCES),
  })
  .strict();

const strategyBaseSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: idSchema,
    account: addressSchema,
    inputKind: z.enum(["erc20", "native"]).optional(),
    tokenIn: addressSchema,
    tokenOut: addressSchema,
    fee: feeSchema,
    slippageBps: z.number().int().min(0).max(9_999),
    authorization: strategyAuthorizationSchema,
    status: statusSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    runsCompleted: z.number().int().nonnegative().max(MAX_OCCURRENCES),
    nextOccurrenceAt: timestampSchema.nullable(),
    inFlightOccurrence: z
      .object({
        occurrenceId: occurrenceIdSchema,
        strategyId: idSchema,
        kind: z.enum(["watcher", "dca"]),
        scheduledAt: timestampSchema,
        runNumber: z.number().int().min(1).max(MAX_OCCURRENCES),
        amountIn: positiveUintSchema.nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((strategy, context) => {
    if (strategy.tokenIn === strategy.tokenOut) {
      context.addIssue({
        code: "custom",
        path: ["tokenOut"],
        message: "tokenOut must differ from tokenIn",
      });
    }
    if (strategy.updatedAt < strategy.createdAt) {
      context.addIssue({
        code: "custom",
        path: ["updatedAt"],
        message: "updatedAt must not precede createdAt",
      });
    }
    if (strategy.status === "active" && strategy.nextOccurrenceAt === null) {
      context.addIssue({
        code: "custom",
        path: ["nextOccurrenceAt"],
        message: "active strategies must have a next occurrence",
      });
    }
    if (strategy.inFlightOccurrence !== null) {
      const kind = (strategy as { kind?: "watcher" | "dca" }).kind;
      if (strategy.inFlightOccurrence.strategyId !== strategy.id) {
        context.addIssue({
          code: "custom",
          path: ["inFlightOccurrence", "strategyId"],
          message: "in-flight occurrence must belong to its strategy",
        });
      }
      if (kind !== undefined && strategy.inFlightOccurrence.kind !== kind) {
        context.addIssue({
          code: "custom",
          path: ["inFlightOccurrence", "kind"],
          message: "in-flight occurrence kind must match its strategy",
        });
      }
      if (kind === "dca" && strategy.inFlightOccurrence.amountIn === null) {
        context.addIssue({
          code: "custom",
          path: ["inFlightOccurrence", "amountIn"],
          message: "in-flight occurrence amount must match its strategy kind",
        });
      }
    }
  });

const watcherSchema = strategyBaseSchema
  .extend({
    kind: z.literal("watcher"),
    amountIn: positiveUintSchema.optional(),
    threshold: thresholdSchema,
    pollIntervalSeconds: intervalSchema,
    maxRuns: z.number().int().min(1).max(MAX_OCCURRENCES).nullable(),
  })
  .strict();

const dcaSchema = strategyBaseSchema
  .extend({
    kind: z.literal("dca"),
    amountIn: positiveUintSchema,
    anchorAt: timestampSchema,
    intervalSeconds: intervalSchema,
    maxRuns: z.number().int().min(1).max(MAX_OCCURRENCES),
  })
  .strict()
  .superRefine((strategy, context) => {
    if (strategy.runsCompleted > strategy.maxRuns) {
      context.addIssue({
        code: "custom",
        path: ["runsCompleted"],
        message: "runsCompleted cannot exceed maxRuns",
      });
    }
  });

const strategySchema = z.discriminatedUnion("kind", [watcherSchema, dcaSchema]);
const strategyBookSchema = z
  .object({
    schemaVersion: z.literal(1),
    account: addressSchema,
    strategies: z.array(strategySchema).max(MAX_STRATEGIES),
  })
  .strict()
  .superRefine((book, context) => {
    const ids = new Set<string>();
    for (const [index, strategy] of book.strategies.entries()) {
      if (strategy.account !== book.account) {
        context.addIssue({
          code: "custom",
          path: ["strategies", index, "account"],
          message: "strategy account must match the book account",
        });
      }
      if (ids.has(strategy.id)) {
        context.addIssue({
          code: "custom",
          path: ["strategies", index, "id"],
          message: "strategy IDs must be unique",
        });
      }
      ids.add(strategy.id);
    }
  });

export type WatcherInput = z.input<typeof watcherInputSchema>;
export type DcaInput = z.input<typeof dcaInputSchema>;
export type WatcherStrategy = z.output<typeof watcherSchema>;
export type DcaStrategy = z.output<typeof dcaSchema>;
export type TradeStrategy = z.output<typeof strategySchema>;
export type StrategyStatus = z.output<typeof statusSchema>;
export type StrategyOccurrence = {
  occurrenceId: string;
  strategyId: string;
  kind: TradeStrategy["kind"];
  scheduledAt: number;
  runNumber: number;
  amountIn: string | null;
};
export type OccurrenceSettlement = "completed" | "not-matched" | "blocked";

export async function createWatcher(
  directory: string,
  input: WatcherInput,
  now = unixNow(),
): Promise<WatcherStrategy> {
  const parsed = watcherInputSchema.parse(input);
  return createStrategy(
    directory,
    {
      ...parsed,
      nextOccurrenceAt: now,
    },
    now,
  ) as Promise<WatcherStrategy>;
}

export async function createDca(
  directory: string,
  input: DcaInput,
  now = unixNow(),
): Promise<DcaStrategy> {
  const parsed = dcaInputSchema.parse(input);
  return createStrategy(
    directory,
    {
      ...parsed,
      nextOccurrenceAt: parsed.anchorAt,
    },
    now,
  ) as Promise<DcaStrategy>;
}

export async function listStrategies(
  directory: string,
  account: string,
  status?: StrategyStatus,
): Promise<TradeStrategy[]> {
  const book = await readBook(directory);
  assertOwner(book, account);
  const parsedStatus =
    status === undefined ? undefined : statusSchema.parse(status);
  return book.strategies
    .filter(
      (strategy) =>
        parsedStatus === undefined || strategy.status === parsedStatus,
    )
    .sort(
      (left, right) =>
        left.createdAt - right.createdAt || compareIds(left.id, right.id),
    );
}

export async function getStrategy(
  directory: string,
  account: string,
  id: string,
): Promise<TradeStrategy> {
  const book = await readBook(directory);
  assertOwner(book, account);
  const strategy = book.strategies.find(
    (candidate) => candidate.id === idSchema.parse(id),
  );
  if (!strategy) throw new Error(`Strategy ${id} does not exist`);
  return strategy;
}

export async function pauseStrategy(
  directory: string,
  account: string,
  id: string,
  now = unixNow(),
): Promise<TradeStrategy> {
  return updateStrategy(directory, account, id, (strategy) => {
    requireStatus(strategy, ["active"], "pause");
    return { ...strategy, status: "paused", updatedAt: now };
  });
}

export async function resumeStrategy(
  directory: string,
  account: string,
  id: string,
  now = unixNow(),
): Promise<TradeStrategy> {
  return updateStrategy(directory, account, id, (strategy) => {
    requireStatus(strategy, ["paused", "blocked"], "resume");
    const nextOccurrenceAt = strategy.nextOccurrenceAt ?? now;
    return { ...strategy, status: "active", nextOccurrenceAt, updatedAt: now };
  });
}

export async function cancelStrategy(
  directory: string,
  account: string,
  id: string,
  now = unixNow(),
): Promise<TradeStrategy> {
  return updateStrategy(directory, account, id, (strategy) => {
    requireStatus(strategy, ["active", "paused", "blocked"], "cancel");
    return {
      ...strategy,
      status: "cancelled",
      nextOccurrenceAt: null,
      updatedAt: now,
    };
  });
}

export async function blockStrategy(
  directory: string,
  account: string,
  id: string,
  now = unixNow(),
): Promise<TradeStrategy> {
  return updateStrategy(directory, account, id, (strategy) => {
    requireStatus(strategy, ["active", "paused"], "block");
    return { ...strategy, status: "blocked", updatedAt: now };
  });
}

export async function completeStrategy(
  directory: string,
  account: string,
  id: string,
  now = unixNow(),
): Promise<TradeStrategy> {
  return updateStrategy(directory, account, id, (strategy) => {
    requireStatus(strategy, ["active", "paused", "blocked"], "complete");
    return {
      ...strategy,
      status: "completed",
      nextOccurrenceAt: null,
      updatedAt: now,
    };
  });
}

/**
 * Claims at most one due occurrence per active strategy. The claim is durable
 * and remains in-flight until settleOccurrence records its outcome.
 */
export async function claimDueOccurrences(
  directory: string,
  account: string,
  now = unixNow(),
): Promise<StrategyOccurrence[]> {
  return withTradeLock(directory, async () => {
    const book = await readBook(directory);
    assertOwner(book, account);
    const occurrences: StrategyOccurrence[] = [];

    for (const strategy of book.strategies) {
      if (strategy.inFlightOccurrence !== null) {
        occurrences.push(strategy.inFlightOccurrence);
        continue;
      }
      if (strategy.status !== "active" || strategy.nextOccurrenceAt === null)
        continue;
      if (strategy.nextOccurrenceAt > now) continue;

      if (strategy.kind === "dca") {
        const nextRun = strategy.runsCompleted + 1;
        const elapsed = Math.max(0, now - strategy.nextOccurrenceAt);
        const skippedRuns = Math.floor(elapsed / strategy.intervalSeconds);
        const runNumber = nextRun + skippedRuns;
        if (runNumber > strategy.maxRuns) {
          strategy.status = "completed";
          strategy.nextOccurrenceAt = null;
          strategy.updatedAt = now;
          continue;
        }

        const occurrence = {
          occurrenceId: occurrenceId(strategy.id, runNumber),
          strategyId: strategy.id,
          kind: strategy.kind,
          scheduledAt:
            strategy.nextOccurrenceAt + skippedRuns * strategy.intervalSeconds,
          runNumber,
          amountIn: strategy.amountIn,
        } satisfies StrategyOccurrence;
        occurrences.push(occurrence);
        strategy.inFlightOccurrence = occurrence;
        strategy.updatedAt = now;
        continue;
      }

      const runNumber = strategy.runsCompleted + 1;
      if (strategy.maxRuns !== null && runNumber > strategy.maxRuns) {
        strategy.status = "completed";
        strategy.nextOccurrenceAt = null;
        strategy.updatedAt = now;
        continue;
      }
      const occurrence = {
        occurrenceId: occurrenceId(strategy.id, runNumber),
        strategyId: strategy.id,
        kind: strategy.kind,
        scheduledAt: strategy.nextOccurrenceAt,
        runNumber,
        amountIn: strategy.amountIn ?? null,
      } satisfies StrategyOccurrence;
      occurrences.push(occurrence);
      strategy.inFlightOccurrence = occurrence;
      strategy.updatedAt = now;
    }

    await writeBook(directory, book);
    return occurrences;
  });
}

export async function settleOccurrence(
  directory: string,
  account: string,
  strategyId: string,
  id: string,
  outcome: OccurrenceSettlement,
  now = unixNow(),
): Promise<TradeStrategy> {
  const parsedOutcome = z
    .enum(["completed", "not-matched", "blocked"])
    .parse(outcome);

  return withTradeLock(directory, async () => {
    const book = await readBook(directory);
    assertOwner(book, account);
    const parsedStrategyId = idSchema.parse(strategyId);
    const strategy = book.strategies.find(
      (candidate) => candidate.id === parsedStrategyId,
    );
    if (!strategy)
      throw new Error(`Strategy ${parsedStrategyId} does not exist`);
    if (strategy.inFlightOccurrence === null) {
      throw new Error(
        `Strategy ${parsedStrategyId} has no in-flight occurrence`,
      );
    }
    if (
      strategy.inFlightOccurrence.occurrenceId !== occurrenceIdSchema.parse(id)
    ) {
      throw new Error(
        "Occurrence does not match the in-flight strategy occurrence",
      );
    }
    if (parsedOutcome === "not-matched" && strategy.kind !== "watcher") {
      throw new Error("not-matched is only valid for watcher strategies");
    }

    const occurrence = strategy.inFlightOccurrence;
    strategy.inFlightOccurrence = null;
    if (parsedOutcome === "blocked") {
      strategy.status = "blocked";
      strategy.updatedAt = now;
      await writeBook(directory, book);
      return strategy;
    }

    strategy.runsCompleted = occurrence.runNumber;
    if (strategy.kind === "dca") {
      if (strategy.runsCompleted >= strategy.maxRuns) {
        strategy.status = "completed";
        strategy.nextOccurrenceAt = null;
      } else {
        strategy.nextOccurrenceAt = futureDcaOccurrence(
          strategy.anchorAt,
          strategy.intervalSeconds,
          strategy.runsCompleted,
          now,
        );
      }
    } else if (
      strategy.maxRuns !== null &&
      strategy.runsCompleted >= strategy.maxRuns
    ) {
      strategy.status = "completed";
      strategy.nextOccurrenceAt = null;
    } else {
      strategy.nextOccurrenceAt = futureWatcherPoll(
        occurrence.scheduledAt,
        strategy.pollIntervalSeconds,
        now,
      );
    }
    strategy.updatedAt = now;
    await writeBook(directory, book);
    return strategy;
  });
}

export function occurrenceId(strategyId: string, runNumber: number): string {
  const id = idSchema.parse(strategyId);
  if (
    !Number.isInteger(runNumber) ||
    runNumber < 1 ||
    runNumber > MAX_OCCURRENCES
  ) {
    throw new Error("runNumber must be between 1 and 10000");
  }
  return `${id}_run_${runNumber.toString().padStart(6, "0")}`;
}

async function createStrategy(
  directory: string,
  input: StrategyCreationInput,
  now: number,
): Promise<TradeStrategy> {
  return withTradeLock(directory, async () => {
    const book = await readBook(directory);
    if (book.strategies.length >= MAX_STRATEGIES)
      throw new Error("Strategy limit reached");
    assertBookAccount(book, input.account);
    if (book.strategies.some((strategy) => strategy.id === input.id)) {
      throw new Error(`Strategy ${input.id} already exists`);
    }
    const strategy = strategySchema.parse({
      schemaVersion: 1,
      ...input,
      status: "active",
      createdAt: now,
      updatedAt: now,
      runsCompleted: 0,
      inFlightOccurrence: null,
    });
    book.strategies.push(strategy);
    await writeBook(directory, book);
    return strategy;
  });
}

type StrategyCreationInput =
  | (WatcherInput & { nextOccurrenceAt: number })
  | (DcaInput & { nextOccurrenceAt: number });

async function updateStrategy(
  directory: string,
  account: string,
  id: string,
  update: (strategy: TradeStrategy) => TradeStrategy,
): Promise<TradeStrategy> {
  return withTradeLock(directory, async () => {
    const book = await readBook(directory);
    assertOwner(book, account);
    const parsedId = idSchema.parse(id);
    const index = book.strategies.findIndex(
      (strategy) => strategy.id === parsedId,
    );
    if (index < 0) throw new Error(`Strategy ${parsedId} does not exist`);
    const updated = strategySchema.parse(update(book.strategies[index]!));
    book.strategies[index] = updated;
    await writeBook(directory, book);
    return updated;
  });
}

async function readBook(
  directory: string,
): Promise<z.output<typeof strategyBookSchema>> {
  try {
    const text = await readFile(join(directory, STRATEGIES_FILE), "utf8");
    if (Buffer.byteLength(text, "utf8") > MAX_STRATEGIES_BYTES) {
      throw new Error("Trade strategies exceed size limit");
    }
    return strategyBookSchema.parse(JSON.parse(text));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        schemaVersion: 1,
        account: addressSchema.parse(
          "0x0000000000000000000000000000000000000001",
        ),
        strategies: [],
      };
    }
    throw error;
  }
}

async function writeBook(
  directory: string,
  book: z.output<typeof strategyBookSchema>,
): Promise<void> {
  const parsed = strategyBookSchema.parse(book);
  if (
    Buffer.byteLength(JSON.stringify(parsed), "utf8") > MAX_STRATEGIES_BYTES
  ) {
    throw new Error("Trade strategies exceed size limit");
  }
  await writeTradeFile(directory, STRATEGIES_FILE, parsed);
}

function assertBookAccount(
  book: z.output<typeof strategyBookSchema>,
  account: string,
): void {
  if (book.strategies.length === 0 && isPlaceholderAccount(book.account)) {
    book.account = addressSchema.parse(account);
    return;
  }
  assertOwner(book, account);
}

function assertOwner(
  book: z.output<typeof strategyBookSchema>,
  account: string,
): void {
  if (
    book.strategies.length > 0 &&
    book.account !== addressSchema.parse(account)
  ) {
    throw new Error("Strategy account does not match the configured wallet");
  }
}

function isPlaceholderAccount(account: string): boolean {
  return account === "0x0000000000000000000000000000000000000001";
}

function requireStatus(
  strategy: TradeStrategy,
  allowed: StrategyStatus[],
  action: string,
): void {
  if (!allowed.includes(strategy.status)) {
    throw new Error(
      `Strategy ${strategy.id} cannot ${action} from ${strategy.status}`,
    );
  }
}

function futureDcaOccurrence(
  anchorAt: number,
  intervalSeconds: number,
  runsCompleted: number,
  now: number,
): number {
  const scheduledAt = anchorAt + runsCompleted * intervalSeconds;
  return futureSlot(scheduledAt, intervalSeconds, now);
}

function futureWatcherPoll(
  scheduledAt: number,
  intervalSeconds: number,
  now: number,
): number {
  return futureSlot(scheduledAt + intervalSeconds, intervalSeconds, now);
}

function futureSlot(
  scheduledAt: number,
  intervalSeconds: number,
  now: number,
): number {
  if (scheduledAt > now) return scheduledAt;
  return (
    scheduledAt +
    Math.ceil((now - scheduledAt + 1) / intervalSeconds) * intervalSeconds
  );
}

function compareIds(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}
