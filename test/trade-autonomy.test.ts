import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  activateAutonomyProposal,
  authorizeAutonomousRequest,
  chooseConfirmEach,
  proposeAutonomy,
  readAutonomyStatus,
  revokeAutonomy,
} from "../src/trade-autonomy.js";
import { ROBINHOOD_WETH9 } from "../src/dex.js";

const account = "0x0000000000000000000000000000000000000001";
const tokenIn = "0x0000000000000000000000000000000000000002";
const tokenOut = "0x0000000000000000000000000000000000000003";

const proposal = {
  id: "daily-buys",
  account,
  inputToken: tokenIn,
  outputTokens: [tokenOut],
  actionKinds: ["quick-buy", "dca", "watcher"] as const,
  maxInputPerTrade: "1000",
  maxInputPerUtcDay: "2500",
  maxInputTotal: "5000",
  maxTradesPerUtcDay: 2,
  maxExecutions: 4,
  maxInputBalanceBps: 1000,
  maxSlippageBps: 100,
  gasLimit: "500000",
  maxFeePerGas: "10000000000",
  maxPriorityFeePerGas: "1000000000",
  maxGasCostPerTrade: "10000000000000000",
  maxGasCostPerUtcDay: "20000000000000000",
  maxDeadlineSeconds: 300,
  minNativeReserveWei: "1000000000000000",
  feeTiers: [3000] as const,
  validUntil: 2_000_000_000,
};

test("autonomy remains choice-required until a reviewed proposal is activated", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gossip-autonomy-"));
  try {
    assert.deepEqual(await readAutonomyStatus(directory), {
      mode: "choice-required",
      executionAuthorized: false,
    });

    const pending = await proposeAutonomy(directory, proposal, 1_900_000_000);
    assert.equal(pending.enabled, false);
    assert.deepEqual(await readAutonomyStatus(directory), {
      mode: "choice-required",
      executionAuthorized: false,
      proposedPolicy: pending,
    });

    const active = await activateAutonomyProposal(
      directory,
      proposal.id,
      account,
      1_900_000_001,
    );
    assert.equal(active.enabled, true);
    assert.deepEqual(await readAutonomyStatus(directory), {
      mode: "bounded-auto",
      executionAuthorized: true,
      policy: active,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("confirm-each records the choice without granting standing authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gossip-autonomy-"));
  try {
    await chooseConfirmEach(directory, 1_900_000_000);
    assert.deepEqual(await readAutonomyStatus(directory), {
      mode: "confirm-each",
      executionAuthorized: false,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("native autonomy is pinned to the verified Robinhood WETH9 route", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gossip-autonomy-"));
  try {
    await assert.rejects(
      proposeAutonomy(
        directory,
        { ...proposal, inputKind: "native", inputToken: tokenIn },
        1_900_000_000,
      ),
      /pinned Robinhood WETH9 route/u,
    );

    const nativePolicy = await proposeAutonomy(
      directory,
      { ...proposal, inputKind: "native", inputToken: ROBINHOOD_WETH9 },
      1_900_000_000,
    );
    assert.equal(nativePolicy.inputKind, "native");
    assert.equal(nativePolicy.inputToken, ROBINHOOD_WETH9);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("autonomy only grants exact in-bounds requests and reserves daily budget idempotently", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gossip-autonomy-"));
  try {
    await proposeAutonomy(directory, proposal, 1_900_000_000);
    await activateAutonomyProposal(
      directory,
      proposal.id,
      account,
      1_900_000_001,
    );
    const request = {
      id: "buy-1",
      policyId: proposal.id,
      actionKind: "quick-buy" as const,
      account,
      tokenIn,
      tokenOut,
      amountIn: "1000",
      inputBalance: "10000",
      fee: 3000 as const,
      slippageBps: 100,
      deadlineSeconds: 120,
      gasLimit: "500000",
      maxFeePerGas: "10000000000",
      maxPriorityFeePerGas: "1000000000",
    };

    const first = await authorizeAutonomousRequest(
      directory,
      request,
      1_900_000_010,
    );
    const retry = await authorizeAutonomousRequest(
      directory,
      request,
      1_900_000_011,
    );
    assert.deepEqual(retry, first);

    await assert.rejects(
      authorizeAutonomousRequest(
        directory,
        { ...request, id: "buy-too-large", amountIn: "1001" },
        1_900_000_012,
      ),
      /per-trade limit/,
    );
    await assert.rejects(
      authorizeAutonomousRequest(
        directory,
        { ...request, id: "buy-wrong-token", tokenOut: tokenIn },
        1_900_000_012,
      ),
      /output token/,
    );

    await authorizeAutonomousRequest(
      directory,
      { ...request, id: "buy-2" },
      1_900_000_012,
    );
    await assert.rejects(
      authorizeAutonomousRequest(
        directory,
        { ...request, id: "buy-3", amountIn: "1" },
        1_900_000_013,
      ),
      /daily trade count/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("revocation is monotonic and prevents new autonomous reservations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gossip-autonomy-"));
  try {
    await proposeAutonomy(directory, proposal, 1_900_000_000);
    await activateAutonomyProposal(
      directory,
      proposal.id,
      account,
      1_900_000_001,
    );
    const revoked = await revokeAutonomy(directory, 1_900_000_002);
    assert.equal(revoked.enabled, false);
    assert.equal(revoked.revokedAt, 1_900_000_002);

    await assert.rejects(
      authorizeAutonomousRequest(
        directory,
        {
          id: "after-revoke",
          policyId: proposal.id,
          actionKind: "quick-buy",
          account,
          tokenIn,
          tokenOut,
          amountIn: "1",
          inputBalance: "10000",
          fee: 3000,
          slippageBps: 1,
          deadlineSeconds: 120,
          gasLimit: "500000",
          maxFeePerGas: "10000000000",
          maxPriorityFeePerGas: "1000000000",
        },
        1_900_000_003,
      ),
      /not active/,
    );

    const stored = JSON.parse(
      await readFile(join(directory, "trade-autonomy.json"), "utf8"),
    );
    assert.equal(stored.enabled, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
