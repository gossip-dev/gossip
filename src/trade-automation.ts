import { Interface, getAddress } from "ethers";
import { mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { createNetworkProvider } from "./network.js";
import {
  resolveExactInputQuote,
  UNISWAP_V3_FEE_TIERS,
  type ExactInputQuote,
  type UniswapV3FeeTier,
} from "./dex.js";
import {
  authorizeAutonomousRequest,
  readActiveAutonomyPolicy,
  type AutonomyPolicy,
} from "./trade-autonomy.js";
import {
  claimDueOccurrences,
  getStrategy,
  settleOccurrence,
  type StrategyOccurrence,
  type TradeStrategy,
} from "./trade-strategies.js";
import {
  executeTrade,
  permissionCanBeReplaced,
  readPermission,
  permissionSchema,
  validatePermission,
  withTradeLock,
  writeTradeFile,
} from "./trade-execution.js";

const token = new Interface([
  "function balanceOf(address) view returns(uint256)",
]);

export type AutomationQuoteRequest = {
  strategy: TradeStrategy;
  amountIn: bigint;
  now: number;
  deadlineSeconds: number;
  feeTiers: readonly UniswapV3FeeTier[];
};

export type AutomationTickDependencies = {
  quote?: (request: AutomationQuoteRequest) => Promise<ExactInputQuote>;
  inputBalance?: (strategy: TradeStrategy) => Promise<bigint>;
  execute?: (directory: string, operationId: string) => Promise<unknown>;
};

export type AutomationOccurrenceResult = {
  occurrenceId: string;
  strategyId: string;
  status:
    | "completed"
    | "not-matched"
    | "awaiting-confirmation"
    | "pending"
    | "blocked"
    | "failed";
  quote?: SerializedQuote;
  execution?: unknown;
  reason?: string;
};

export type AutomationTickResult = {
  account: string;
  now: number;
  occurrences: AutomationOccurrenceResult[];
};

type SerializedQuote = {
  chainId: string;
  account: string;
  router: string;
  tokenIn: string;
  tokenOut: string;
  inputKind: "erc20" | "native";
  fee: 100 | 500 | 3000 | 10000;
  amountIn: string;
  quotedAmountOut: string;
  amountOutMinimum: string;
  deadline: string;
  quoter: string;
  factory: string;
  pool: string;
  transaction: { to: string; data: string; value: string };
  executionAuthorized: false;
};

/** Execute one durable pass. An in-flight occurrence is always retried by ID. */
export async function automationTick(
  directory: string,
  account: string,
  now = Math.floor(Date.now() / 1000),
  dependencies: AutomationTickDependencies = {},
): Promise<AutomationTickResult> {
  const occurrences = await claimDueOccurrences(directory, account, now);
  const results: AutomationOccurrenceResult[] = [];

  for (const occurrence of occurrences) {
    results.push(
      await processOccurrence(
        directory,
        account,
        occurrence,
        now,
        dependencies,
      ),
    );
  }

  return { account: getAddress(account), now, occurrences: results };
}

export const runAutomationTick = automationTick;

export async function runAutomationWorker(
  directory: string,
  account: string,
  options: {
    intervalSeconds: number;
    signal?: AbortSignal;
    onTick?: (result: AutomationTickResult) => void;
  },
): Promise<void> {
  if (
    !Number.isInteger(options.intervalSeconds) ||
    options.intervalSeconds < 5 ||
    options.intervalSeconds > 3600
  ) {
    throw new Error("Automation interval must be between 5 and 3600 seconds");
  }

  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = join(directory, "trade-worker.lock");
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        "Another trading worker may be running; inspect the recorded process before removing trade-worker.lock",
      );
    }
    throw error;
  }

  try {
    while (!options.signal?.aborted) {
      const result = await automationTick(directory, account);
      options.onTick?.(result);
      if (options.signal?.aborted) break;
      await waitForNextTick(options.intervalSeconds, options.signal);
    }
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

async function waitForNextTick(
  intervalSeconds: number,
  signal?: AbortSignal,
): Promise<void> {
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timeout = setTimeout(finish, intervalSeconds * 1000);
    if (signal === undefined) return;
    if (signal.aborted) {
      finish();
      return;
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

async function processOccurrence(
  directory: string,
  account: string,
  occurrence: StrategyOccurrence,
  now: number,
  dependencies: AutomationTickDependencies,
): Promise<AutomationOccurrenceResult> {
  const base = {
    occurrenceId: occurrence.occurrenceId,
    strategyId: occurrence.strategyId,
  };
  const strategy = await getStrategy(directory, account, occurrence.strategyId);
  const storedPermission = await existingPermission(
    directory,
    occurrence.occurrenceId,
  );

  let policy: AutonomyPolicy | undefined;
  if (strategy.authorization.kind === "standing-envelope") {
    try {
      policy = await readActiveAutonomyPolicy(directory, now);
      assertStrategyPolicy(strategy, policy);
    } catch (error) {
      if (storedPermission !== null) {
        assertStandingPermissionBinding(storedPermission, occurrence, strategy);
        return executeAndSettle(
          directory,
          account,
          occurrence,
          now,
          dependencies.execute ?? executeTrade,
          base,
        );
      }
      const reason = errorMessage(error);
      await settleOccurrence(
        directory,
        account,
        occurrence.strategyId,
        occurrence.occurrenceId,
        "blocked",
        now,
      );
      return { ...base, status: "blocked", reason };
    }
  }

  if (occurrence.amountIn === null) {
    const reason =
      "Watcher has no input amount; add --amount-in before it can execute";
    await settleOccurrence(
      directory,
      account,
      occurrence.strategyId,
      occurrence.occurrenceId,
      "blocked",
      now,
    );
    return { ...base, status: "blocked", reason };
  }

  const existing = storedPermission;
  if (existing !== null) {
    if (policy === undefined) {
      assertConfirmEachPermission(existing, occurrence, strategy);
    } else {
      assertPermissionForOccurrence(existing, occurrence, strategy, policy);
    }
    return executeAndSettle(
      directory,
      account,
      occurrence,
      now,
      dependencies.execute ?? executeTrade,
      base,
    );
  }

  let quote: ExactInputQuote;
  try {
    const quoteRunner =
      dependencies.quote ??
      ((request: AutomationQuoteRequest) => defaultQuote(directory, request));
    quote = await quoteRunner({
      strategy,
      amountIn: BigInt(occurrence.amountIn),
      now,
      deadlineSeconds: policy?.maxDeadlineSeconds ?? 300,
      feeTiers:
        strategy.fee === undefined
          ? (policy?.feeTiers ?? UNISWAP_V3_FEE_TIERS)
          : [strategy.fee],
    });
  } catch (error) {
    return { ...base, status: "failed", reason: errorMessage(error) };
  }
  try {
    assertQuoteMatchesStrategy(
      quote,
      strategy,
      occurrence.amountIn,
      now,
      policy?.maxDeadlineSeconds ?? 300,
    );
  } catch (error) {
    return { ...base, status: "failed", reason: errorMessage(error) };
  }

  const serializedQuote = serializeQuote(quote, strategy.account);
  if (
    strategy.kind === "watcher" &&
    !watcherMatches(strategy, quote.amountOutMinimum)
  ) {
    await settleOccurrence(
      directory,
      account,
      occurrence.strategyId,
      occurrence.occurrenceId,
      "not-matched",
      now,
    );
    return { ...base, status: "not-matched", quote: serializedQuote };
  }

  if (policy === undefined) {
    return {
      ...base,
      status: "awaiting-confirmation",
      quote: serializedQuote,
      reason: "Confirm this exact quote before executing the occurrence",
    };
  }

  try {
    const inputBalance = await (
      dependencies.inputBalance ??
      ((candidate: TradeStrategy) => defaultInputBalance(directory, candidate))
    )(strategy);
    const reservation = await authorizeAutonomousRequest(
      directory,
      {
        id: occurrence.occurrenceId,
        policyId: policy.id,
        actionKind: strategy.kind,
        inputKind: strategy.inputKind ?? "erc20",
        account: strategy.account,
        tokenIn: strategy.tokenIn,
        tokenOut: strategy.tokenOut,
        amountIn: occurrence.amountIn,
        inputBalance: inputBalance.toString(),
        fee: quote.fee as UniswapV3FeeTier,
        slippageBps: strategy.slippageBps,
        deadlineSeconds: policy.maxDeadlineSeconds,
        gasLimit: policy.gasLimit,
        maxFeePerGas: policy.maxFeePerGas,
        maxPriorityFeePerGas: policy.maxPriorityFeePerGas,
      },
      now,
    );
    const permission = permissionSchema.parse({
      schemaVersion: 1,
      id: occurrence.occurrenceId,
      enabled: true,
      quote: serializedQuote,
      gasLimit: policy.gasLimit,
      maxFeePerGas: policy.maxFeePerGas,
      maxPriorityFeePerGas: policy.maxPriorityFeePerGas,
      minNativeReserveWei: policy.minNativeReserveWei,
      authorizationSource: {
        kind: "standing-envelope",
        envelopeId: policy.id,
        envelopeRevision: policy.revision,
        requestId: occurrence.occurrenceId,
        reservationFingerprint: reservation.fingerprint,
        requestIntent: {
          tokenOut: strategy.tokenOut,
          inputKind: strategy.inputKind ?? "erc20",
          spendType: "fixed",
          spendValue: occurrence.amountIn,
        },
      },
    });
    validatePermission(permission);
    await storePermission(directory, permission);
  } catch (error) {
    const reason = errorMessage(error);
    await settleOccurrence(
      directory,
      account,
      occurrence.strategyId,
      occurrence.occurrenceId,
      "blocked",
      now,
    );
    return { ...base, status: "blocked", quote: serializedQuote, reason };
  }

  return executeAndSettle(
    directory,
    account,
    occurrence,
    now,
    dependencies.execute ?? executeTrade,
    base,
    serializedQuote,
  );
}

async function executeAndSettle(
  directory: string,
  account: string,
  occurrence: StrategyOccurrence,
  now: number,
  execute: (directory: string, operationId: string) => Promise<unknown>,
  base: Pick<AutomationOccurrenceResult, "occurrenceId" | "strategyId">,
  quote?: SerializedQuote,
): Promise<AutomationOccurrenceResult> {
  try {
    const execution = await execute(directory, occurrence.occurrenceId);
    const status = executionStatus(execution);
    if (status === "completed") {
      await settleOccurrence(
        directory,
        account,
        occurrence.strategyId,
        occurrence.occurrenceId,
        "completed",
        now,
      );
    } else if (status === "blocked") {
      await settleOccurrence(
        directory,
        account,
        occurrence.strategyId,
        occurrence.occurrenceId,
        "blocked",
        now,
      );
    }
    return { ...base, status, ...(quote ? { quote } : {}), execution };
  } catch (error) {
    return {
      ...base,
      status: "failed",
      ...(quote ? { quote } : {}),
      reason: errorMessage(error),
    };
  }
}

function executionStatus(
  execution: unknown,
): "completed" | "pending" | "blocked" {
  if (
    typeof execution === "object" &&
    execution !== null &&
    "status" in execution
  ) {
    const status = (execution as { status?: unknown }).status;
    if (status === "confirmed") return "completed";
    if (status === "reverted") return "blocked";
    if (status === "pending" || status === "reorg") return "pending";
  }
  return "pending";
}

function watcherMatches(
  strategy: Extract<TradeStrategy, { kind: "watcher" }>,
  quotedAmountOut: bigint,
): boolean {
  const threshold = BigInt(strategy.threshold.amountOut);
  return strategy.threshold.comparison === "at-or-above"
    ? quotedAmountOut >= threshold
    : quotedAmountOut <= threshold;
}

function assertQuoteMatchesStrategy(
  quote: ExactInputQuote,
  strategy: TradeStrategy,
  amountIn: string,
  now: number,
  maxDeadlineSeconds: number,
): void {
  if (
    getAddress(quote.tokenIn) !== strategy.tokenIn ||
    getAddress(quote.tokenOut) !== strategy.tokenOut ||
    quote.inputKind !== (strategy.inputKind ?? "erc20") ||
    (strategy.fee !== undefined && quote.fee !== strategy.fee) ||
    quote.amountIn !== BigInt(amountIn) ||
    quote.deadline <= BigInt(now) ||
    quote.deadline > BigInt(now + maxDeadlineSeconds)
  ) {
    throw new Error("Automation quote does not match the strategy bounds");
  }
}

function assertStrategyPolicy(
  strategy: TradeStrategy,
  policy: AutonomyPolicy,
): void {
  const authorization = strategy.authorization;
  if (
    authorization.kind !== "standing-envelope" ||
    policy.id !== authorization.policyId ||
    policy.revision !== authorization.policyRevision ||
    policy.account !== strategy.account ||
    (policy.inputKind ?? "erc20") !== (strategy.inputKind ?? "erc20") ||
    policy.inputToken !== strategy.tokenIn ||
    !policy.outputTokens.includes(strategy.tokenOut) ||
    !policy.actionKinds.includes(strategy.kind) ||
    (strategy.fee !== undefined && !policy.feeTiers.includes(strategy.fee)) ||
    strategy.slippageBps > policy.maxSlippageBps
  ) {
    throw new Error("Strategy no longer fits the active autonomy policy");
  }
}

async function existingPermission(
  directory: string,
  id: string,
): Promise<ReturnType<typeof permissionSchema.parse> | null> {
  try {
    const permission = await readPermission(directory);
    return permission.id === id ? permission : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function assertConfirmEachPermission(
  permission: ReturnType<typeof permissionSchema.parse>,
  occurrence: StrategyOccurrence,
  strategy: TradeStrategy,
): void {
  validatePermission(permission);
  if (
    !permission.enabled ||
    permission.id !== occurrence.occurrenceId ||
    permission.authorizationSource !== undefined ||
    permission.quote.account !== strategy.account ||
    permission.quote.tokenIn !== strategy.tokenIn ||
    permission.quote.tokenOut !== strategy.tokenOut ||
    (permission.quote.inputKind ?? "erc20") !==
      (strategy.inputKind ?? "erc20") ||
    (strategy.fee !== undefined && permission.quote.fee !== strategy.fee) ||
    permission.quote.amountIn !== occurrence.amountIn
  ) {
    throw new Error(
      "Confirmed trade permission does not match the strategy occurrence",
    );
  }
}

function assertStandingPermissionBinding(
  permission: ReturnType<typeof permissionSchema.parse>,
  occurrence: StrategyOccurrence,
  strategy: TradeStrategy,
): void {
  validatePermission(permission);
  const authorization = strategy.authorization;
  const source = permission.authorizationSource;
  if (
    authorization.kind !== "standing-envelope" ||
    permission.id !== occurrence.occurrenceId ||
    source?.kind !== "standing-envelope" ||
    source.envelopeId !== authorization.policyId ||
    source.envelopeRevision !== authorization.policyRevision ||
    source.requestId !== occurrence.occurrenceId ||
    source.requestIntent.tokenOut !== strategy.tokenOut ||
    (source.requestIntent.inputKind ?? "erc20") !==
      (strategy.inputKind ?? "erc20") ||
    source.requestIntent.spendType !== "fixed" ||
    source.requestIntent.spendValue !== occurrence.amountIn
  ) {
    throw new Error("Stored permission does not match strategy authorization");
  }
}

function assertPermissionForOccurrence(
  permission: ReturnType<typeof permissionSchema.parse>,
  occurrence: StrategyOccurrence,
  strategy: TradeStrategy,
  policy: AutonomyPolicy,
): void {
  const source = permission.authorizationSource;
  if (
    permission.id !== occurrence.occurrenceId ||
    source?.kind !== "standing-envelope" ||
    source.envelopeId !== policy.id ||
    source.envelopeRevision !== policy.revision ||
    source.requestId !== occurrence.occurrenceId ||
    (source.requestIntent.inputKind ?? "erc20") !==
      (strategy.inputKind ?? "erc20") ||
    source.requestIntent.tokenOut !== strategy.tokenOut ||
    source.requestIntent.spendType !== "fixed" ||
    source.requestIntent.spendValue !== occurrence.amountIn ||
    permission.quote.account !== strategy.account ||
    permission.quote.tokenIn !== strategy.tokenIn ||
    permission.quote.tokenOut !== strategy.tokenOut ||
    (permission.quote.inputKind ?? "erc20") !==
      (strategy.inputKind ?? "erc20") ||
    !policy.feeTiers.includes(permission.quote.fee) ||
    (strategy.fee !== undefined && permission.quote.fee !== strategy.fee) ||
    permission.quote.amountIn !== occurrence.amountIn
  ) {
    throw new Error("Existing trade permission does not match occurrence");
  }
}

async function storePermission(
  directory: string,
  permission: ReturnType<typeof permissionSchema.parse>,
): Promise<void> {
  await withTradeLock(directory, async () => {
    try {
      const current = await readPermission(directory);
      if (
        current.id !== permission.id &&
        !(await permissionCanBeReplaced(directory, current.id))
      ) {
        throw new Error(
          "Existing trade permission must be reconciled before replacement",
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await writeTradeFile(directory, "trade-permission.json", permission);
  });
}

async function defaultQuote(
  directory: string,
  request: AutomationQuoteRequest,
): Promise<ExactInputQuote> {
  const provider = await createNetworkProvider(directory, {
    retryReadiness: {},
  });
  try {
    return await resolveExactInputQuote({
      provider,
      recipient: request.strategy.account,
      tokenIn: request.strategy.tokenIn,
      tokenOut: request.strategy.tokenOut,
      amountIn: request.amountIn,
      feeTiers: request.feeTiers,
      slippageBps: request.strategy.slippageBps,
      deadlineSecs: request.deadlineSeconds,
      nowSecs: request.now,
      inputKind: request.strategy.inputKind ?? "erc20",
    });
  } finally {
    provider.destroy();
  }
}

async function defaultInputBalance(
  directory: string,
  strategy: TradeStrategy,
): Promise<bigint> {
  const provider = await createNetworkProvider(directory);
  try {
    if ((strategy.inputKind ?? "erc20") === "native") {
      return await provider.getBalance(strategy.account);
    }
    const result = await provider.call({
      to: strategy.tokenIn,
      data: token.encodeFunctionData("balanceOf", [strategy.account]),
    });
    return token.decodeFunctionResult("balanceOf", result)[0] as bigint;
  } finally {
    provider.destroy();
  }
}

function serializeQuote(
  quote: ExactInputQuote,
  account: string,
): SerializedQuote {
  return {
    chainId: quote.chainId.toString(),
    account: getAddress(account),
    router: getAddress(quote.router),
    tokenIn: getAddress(quote.tokenIn),
    tokenOut: getAddress(quote.tokenOut),
    inputKind: quote.inputKind,
    fee: quote.fee as SerializedQuote["fee"],
    amountIn: quote.amountIn.toString(),
    quotedAmountOut: quote.quotedAmountOut.toString(),
    amountOutMinimum: quote.amountOutMinimum.toString(),
    deadline: quote.deadline.toString(),
    quoter: getAddress(quote.quoter),
    factory: getAddress(quote.factory),
    pool: getAddress(quote.pool),
    transaction: {
      to: getAddress(quote.transaction.to),
      data: quote.transaction.data,
      value: quote.transaction.value.toString(),
    },
    executionAuthorized: false,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Automation tick failed";
}
