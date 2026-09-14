import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSwapTransaction,
  QUOTER_V2,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_WETH9,
  SWAP_ROUTER02,
  V3_FACTORY,
} from "../src/dex.js";
import {
  activateAutonomyProposal,
  proposeAutonomy,
  revokeAutonomy,
} from "../src/trade-autonomy.js";
import {
  automationTick,
  runAutomationWorker,
} from "../src/trade-automation.js";
import {
  createDca,
  createWatcher,
  getStrategy,
} from "../src/trade-strategies.js";
import { readPermission } from "../src/trade-execution.js";

const account = "0x0000000000000000000000000000000000000001";
const tokenIn = "0x0000000000000000000000000000000000000011";
const tokenOut = "0x0000000000000000000000000000000000000012";
const pool = "0x0000000000000000000000000000000000000013";

function quote(amountIn: bigint, amountOut: bigint, now: number) {
  return {
    chainId: ROBINHOOD_CHAIN_ID,
    router: SWAP_ROUTER02,
    quoter: QUOTER_V2,
    factory: V3_FACTORY,
    pool,
    tokenIn,
    tokenOut,
    inputKind: "erc20" as const,
    fee: 3000,
    amountIn,
    quotedAmountOut: amountOut,
    amountOutMinimum: amountOut,
    deadline: BigInt(now + 300),
    transaction: buildSwapTransaction({
      tokenIn,
      tokenOut,
      fee: 3000,
      recipient: account,
      amountIn,
      amountOutMinimum: amountOut,
      deadline: BigInt(now + 300),
    }),
  };
}

function proposal(validUntil: number) {
  return {
    id: "automation-policy",
    account,
    inputToken: tokenIn,
    outputTokens: [tokenOut],
    actionKinds: ["dca", "watcher"] as const,
    maxInputPerTrade: "1000",
    maxInputPerUtcDay: "5000",
    maxInputTotal: "10000",
    maxTradesPerUtcDay: 5,
    maxExecutions: 10,
    maxInputBalanceBps: 10000,
    maxSlippageBps: 100,
    gasLimit: "500000",
    maxFeePerGas: "10000000000",
    maxPriorityFeePerGas: "1000000000",
    maxGasCostPerTrade: "10000000000000000",
    maxGasCostPerUtcDay: "50000000000000000",
    maxDeadlineSeconds: 300,
    minNativeReserveWei: "0",
    feeTiers: [3000] as const,
    validUntil,
  };
}

test("confirm-each tick stops at an explicit state and keeps the occurrence durable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gossip-automation-"));
  try {
    await createDca(
      directory,
      {
        kind: "dca",
        id: "confirm-dca",
        account,
        tokenIn,
        tokenOut,
        slippageBps: 100,
        authorization: { kind: "confirm-each" },
        amountIn: "100",
        anchorAt: 100,
        intervalSeconds: 60,
        maxRuns: 2,
      },
      100,
    );

    let executions = 0;
    const dependencies = {
      quote: async ({ amountIn, now }: { amountIn: bigint; now: number }) =>
        quote(amountIn, 200n, now),
      execute: async () => {
        executions += 1;
        return { status: "confirmed" };
      },
    };
    const first = await automationTick(directory, account, 100, dependencies);
    const retry = await automationTick(directory, account, 101, dependencies);

    assert.equal(first.occurrences[0]?.status, "awaiting-confirmation");
    assert.equal(retry.occurrences[0]?.status, "awaiting-confirmation");
    assert.equal(executions, 0);
    assert.equal(
      (await getStrategy(directory, account, "confirm-dca")).inFlightOccurrence
        ?.occurrenceId,
      "confirm-dca_run_000001",
    );
    await writeFile(
      join(directory, "trade-permission.json"),
      JSON.stringify({
        schemaVersion: 1,
        id: "confirm-dca_run_000001",
        enabled: true,
        quote: first.occurrences[0]!.quote,
        gasLimit: "500000",
        maxFeePerGas: "10000000000",
      }),
      "utf8",
    );
    const confirmed = await automationTick(
      directory,
      account,
      102,
      dependencies,
    );
    assert.equal(confirmed.occurrences[0]?.status, "completed");
    assert.equal(executions, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("foreground worker is singleton and releases its lock on clean shutdown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gossip-automation-"));
  try {
    const controller = new AbortController();
    let ticks = 0;
    await runAutomationWorker(directory, account, {
      intervalSeconds: 5,
      signal: controller.signal,
      onTick: () => {
        ticks += 1;
        controller.abort();
      },
    });
    assert.equal(ticks, 1);
    await assert.rejects(() => access(join(directory, "trade-worker.lock")));

    await writeFile(join(directory, "trade-worker.lock"), "busy", "utf8");
    await assert.rejects(
      runAutomationWorker(directory, account, { intervalSeconds: 5 }),
      /Another trading worker may be running/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a watcher settles not-matched without creating a permission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gossip-automation-"));
  try {
    await createWatcher(
      directory,
      {
        kind: "watcher",
        id: "watcher-1",
        account,
        tokenIn,
        tokenOut,
        amountIn: "100",
        fee: 3000,
        slippageBps: 100,
        authorization: { kind: "confirm-each" },
        threshold: { comparison: "at-or-above", amountOut: "500" },
        pollIntervalSeconds: 60,
        maxRuns: null,
      },
      100,
    );

    const result = await automationTick(directory, account, 100, {
      quote: async ({ amountIn, now }) => quote(amountIn, 499n, now),
    });

    assert.equal(result.occurrences[0]?.status, "not-matched");
    const strategy = await getStrategy(directory, account, "watcher-1");
    assert.equal(strategy.inFlightOccurrence, null);
    assert.equal(strategy.nextOccurrenceAt, 160);
    await assert.rejects(() =>
      readFile(join(directory, "trade-permission.json")),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bounded DCA retries the same operation after a pending execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gossip-automation-"));
  try {
    await proposeAutonomy(directory, proposal(10_000), 100);
    await activateAutonomyProposal(
      directory,
      "automation-policy",
      account,
      101,
    );
    await createDca(
      directory,
      {
        kind: "dca",
        id: "bounded-dca",
        account,
        tokenIn,
        tokenOut,
        slippageBps: 100,
        authorization: {
          kind: "standing-envelope",
          policyId: "automation-policy",
          policyRevision: 1,
        },
        amountIn: "100",
        anchorAt: 100,
        intervalSeconds: 60,
        maxRuns: 1,
      },
      100,
    );

    let quoteCalls = 0;
    let requestedFeeTiers: readonly number[] = [];
    const operationIds: string[] = [];
    let attempts = 0;
    const dependencies = {
      quote: async ({ amountIn, now, feeTiers }) => {
        quoteCalls += 1;
        requestedFeeTiers = feeTiers;
        return quote(amountIn, 200n, now);
      },
      inputBalance: async () => 1000n,
      execute: async (_directory: string, operationId: string) => {
        operationIds.push(operationId);
        attempts += 1;
        return { status: attempts === 1 ? "pending" : "confirmed" };
      },
    };

    const first = await automationTick(directory, account, 101, dependencies);
    await revokeAutonomy(directory, 102);
    const retry = await automationTick(directory, account, 103, dependencies);

    assert.equal(first.occurrences[0]?.status, "pending");
    assert.equal(retry.occurrences[0]?.status, "completed");
    assert.equal(quoteCalls, 1);
    assert.deepEqual(requestedFeeTiers, [3000]);
    assert.equal((await readPermission(directory)).quote.fee, 3000);
    assert.deepEqual(operationIds, [
      "bounded-dca_run_000001",
      "bounded-dca_run_000001",
    ]);
    assert.equal(
      (await getStrategy(directory, account, "bounded-dca")).status,
      "completed",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bounded native DCA carries exact ETH value and creates no ERC-20 assumption", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gossip-automation-"));
  try {
    const nativePolicy = {
      ...proposal(10_000),
      inputKind: "native" as const,
      inputToken: ROBINHOOD_WETH9,
      maxInputPerTrade: "100",
    };
    await proposeAutonomy(directory, nativePolicy, 100);
    await activateAutonomyProposal(directory, nativePolicy.id, account, 101);
    await createDca(
      directory,
      {
        kind: "dca",
        id: "native-dca",
        account,
        inputKind: "native",
        tokenIn: ROBINHOOD_WETH9,
        tokenOut,
        fee: 3000,
        slippageBps: 100,
        authorization: {
          kind: "standing-envelope",
          policyId: nativePolicy.id,
          policyRevision: 1,
        },
        amountIn: "100",
        anchorAt: 100,
        intervalSeconds: 60,
        maxRuns: 1,
      },
      100,
    );

    const result = await automationTick(directory, account, 101, {
      quote: async ({ amountIn, now }) => ({
        ...quote(amountIn, 200n, now),
        tokenIn: ROBINHOOD_WETH9,
        inputKind: "native",
        transaction: buildSwapTransaction({
          tokenIn: ROBINHOOD_WETH9,
          tokenOut,
          fee: 3000,
          recipient: account,
          amountIn,
          amountOutMinimum: 200n,
          deadline: BigInt(now + 300),
          inputKind: "native",
        }),
      }),
      inputBalance: async () => 10_000n,
      execute: async () => ({ status: "confirmed" }),
    });

    assert.equal(result.occurrences[0]?.status, "completed");
    const permission = await readPermission(directory);
    assert.equal(permission.quote.inputKind, "native");
    assert.equal(permission.quote.transaction.value, "100");
    assert.equal(
      permission.authorizationSource?.requestIntent.inputKind,
      "native",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a strategy is blocked when its standing policy revision is no longer active", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gossip-automation-"));
  try {
    const policy = proposal(10_000);
    await proposeAutonomy(directory, policy, 100);
    await activateAutonomyProposal(directory, policy.id, account, 101);
    await createDca(
      directory,
      {
        kind: "dca",
        id: "stale-policy-dca",
        account,
        tokenIn,
        tokenOut,
        fee: 3000,
        slippageBps: 100,
        authorization: {
          kind: "standing-envelope",
          policyId: policy.id,
          policyRevision: 1,
        },
        amountIn: "100",
        anchorAt: 100,
        intervalSeconds: 60,
        maxRuns: 1,
      },
      100,
    );
    await revokeAutonomy(directory, 102);
    await proposeAutonomy(directory, policy, 103);
    await activateAutonomyProposal(directory, policy.id, account, 104);

    const result = await automationTick(directory, account, 105, {
      quote: async ({ amountIn, now }) => quote(amountIn, 200n, now),
    });

    assert.equal(result.occurrences[0]?.status, "blocked");
    assert.equal(
      (await getStrategy(directory, account, "stale-policy-dca")).status,
      "blocked",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
