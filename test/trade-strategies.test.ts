import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  blockStrategy,
  cancelStrategy,
  claimDueOccurrences,
  completeStrategy,
  createDca,
  createWatcher,
  getStrategy,
  listStrategies,
  pauseStrategy,
  resumeStrategy,
  settleOccurrence,
} from "../src/trade-strategies.js";

const account = "0x0000000000000000000000000000000000000001";
const otherAccount = "0x0000000000000000000000000000000000000002";
const tokenIn = "0x0000000000000000000000000000000000000011";
const tokenOut = "0x0000000000000000000000000000000000000012";

test("persists one owner account and rejects a different owner", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gossip-strategies-"));

  try {
    const watcher = await createWatcher(
      directory,
      {
        kind: "watcher",
        id: "watch-1",
        account,
        tokenIn,
        tokenOut,
        fee: 3000,
        slippageBps: 100,
        authorization: { kind: "confirm-each" },
        threshold: { comparison: "at-or-below", amountOut: "950" },
        pollIntervalSeconds: 60,
        maxRuns: null,
      },
      100,
    );

    assert.equal(watcher.status, "active");
    assert.deepEqual(
      (await listStrategies(directory, account)).map((item) => item.id),
      ["watch-1"],
    );
    await assert.rejects(
      () => listStrategies(directory, otherAccount),
      /does not match/i,
    );
    await assert.rejects(
      () => getStrategy(directory, otherAccount, "watch-1"),
      /does not match/i,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("supports DCA lifecycle and deterministic due occurrences", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gossip-strategies-"));

  try {
    await createDca(
      directory,
      {
        kind: "dca",
        id: "dca-1",
        account,
        tokenIn,
        tokenOut,
        fee: 500,
        slippageBps: 50,
        authorization: { kind: "confirm-each" },
        amountIn: "1000",
        anchorAt: 1_000,
        intervalSeconds: 60,
        maxRuns: 3,
      },
      900,
    );

    assert.equal(
      (await pauseStrategy(directory, account, "dca-1", 901)).status,
      "paused",
    );
    assert.equal(
      (await resumeStrategy(directory, account, "dca-1", 902)).status,
      "active",
    );
    assert.deepEqual(await claimDueOccurrences(directory, account, 999), []);

    const first = await claimDueOccurrences(directory, account, 1_001);
    assert.deepEqual(first, [
      {
        occurrenceId: "dca-1_run_000001",
        strategyId: "dca-1",
        kind: "dca",
        scheduledAt: 1_000,
        runNumber: 1,
        amountIn: "1000",
      },
    ]);
    assert.deepEqual(
      await claimDueOccurrences(directory, account, 1_500),
      first,
    );
    assert.equal(
      (await getStrategy(directory, account, "dca-1")).runsCompleted,
      0,
    );
    await settleOccurrence(
      directory,
      account,
      "dca-1",
      "dca-1_run_000001",
      "completed",
      1_002,
    );

    const second = await claimDueOccurrences(directory, account, 1_121);
    assert.deepEqual(second, [
      {
        occurrenceId: "dca-1_run_000003",
        strategyId: "dca-1",
        kind: "dca",
        scheduledAt: 1_120,
        runNumber: 3,
        amountIn: "1000",
      },
    ]);
    assert.deepEqual(
      await claimDueOccurrences(directory, account, 1_200),
      second,
    );
    await settleOccurrence(
      directory,
      account,
      "dca-1",
      "dca-1_run_000003",
      "completed",
      1_121,
    );
    assert.equal(
      (await getStrategy(directory, account, "dca-1")).status,
      "completed",
    );
    assert.deepEqual(await claimDueOccurrences(directory, account, 10_000), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("watcher occurrences poll on a stable interval and complete at maxRuns", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gossip-strategies-"));

  try {
    await createWatcher(
      directory,
      {
        kind: "watcher",
        id: "watch-2",
        account,
        tokenIn,
        tokenOut,
        fee: 100,
        slippageBps: 0,
        authorization: { kind: "confirm-each" },
        threshold: { comparison: "at-or-above", amountOut: "2" },
        pollIntervalSeconds: 60,
        maxRuns: 2,
      },
      100,
    );
    assert.deepEqual(await claimDueOccurrences(directory, account, 100), [
      {
        occurrenceId: "watch-2_run_000001",
        strategyId: "watch-2",
        kind: "watcher",
        scheduledAt: 100,
        runNumber: 1,
        amountIn: null,
      },
    ]);
    await settleOccurrence(
      directory,
      account,
      "watch-2",
      "watch-2_run_000001",
      "not-matched",
      100,
    );
    assert.deepEqual(await claimDueOccurrences(directory, account, 159), []);
    const final = await claimDueOccurrences(directory, account, 160);
    assert.equal(final[0]?.occurrenceId, "watch-2_run_000002");
    await settleOccurrence(
      directory,
      account,
      "watch-2",
      "watch-2_run_000002",
      "completed",
      160,
    );
    assert.equal(
      (await getStrategy(directory, account, "watch-2")).status,
      "completed",
    );

    await createWatcher(
      directory,
      {
        kind: "watcher",
        id: "watch-2-late",
        account,
        tokenIn,
        tokenOut,
        fee: 100,
        slippageBps: 0,
        authorization: { kind: "confirm-each" },
        threshold: { comparison: "at-or-above", amountOut: "2" },
        pollIntervalSeconds: 60,
        maxRuns: null,
      },
      100,
    );
    await claimDueOccurrences(directory, account, 301);
    assert.equal(
      (await getStrategy(directory, account, "watch-2-late")).nextOccurrenceAt,
      100,
    );
    await settleOccurrence(
      directory,
      account,
      "watch-2-late",
      "watch-2-late_run_000001",
      "not-matched",
      301,
    );
    assert.equal(
      (await getStrategy(directory, account, "watch-2-late")).nextOccurrenceAt,
      340,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("supports blocked recovery, cancellation, completion, and strict storage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gossip-strategies-"));

  try {
    await createWatcher(
      directory,
      {
        kind: "watcher",
        id: "watch-3",
        account,
        tokenIn,
        tokenOut,
        fee: 3000,
        slippageBps: 100,
        authorization: { kind: "confirm-each" },
        threshold: { comparison: "at-or-below", amountOut: "1" },
        pollIntervalSeconds: 60,
        maxRuns: null,
      },
      10,
    );
    assert.equal(
      (await blockStrategy(directory, account, "watch-3", 11)).status,
      "blocked",
    );
    assert.equal(
      (await resumeStrategy(directory, account, "watch-3", 12)).status,
      "active",
    );
    const blockedOccurrence = await claimDueOccurrences(directory, account, 12);
    assert.equal(blockedOccurrence[0]?.occurrenceId, "watch-3_run_000001");
    await settleOccurrence(
      directory,
      account,
      "watch-3",
      "watch-3_run_000001",
      "blocked",
      13,
    );
    assert.equal(
      (await getStrategy(directory, account, "watch-3")).status,
      "blocked",
    );
    assert.equal(
      (await resumeStrategy(directory, account, "watch-3", 14)).status,
      "active",
    );
    assert.equal(
      (await claimDueOccurrences(directory, account, 14))[0]?.occurrenceId,
      "watch-3_run_000001",
    );
    await settleOccurrence(
      directory,
      account,
      "watch-3",
      "watch-3_run_000001",
      "not-matched",
      14,
    );
    assert.equal(
      (await cancelStrategy(directory, account, "watch-3", 15)).status,
      "cancelled",
    );
    await assert.rejects(
      () => resumeStrategy(directory, account, "watch-3"),
      /cannot resume/i,
    );

    await createWatcher(
      directory,
      {
        kind: "watcher",
        id: "watch-4",
        account,
        tokenIn,
        tokenOut,
        fee: 3000,
        slippageBps: 100,
        authorization: { kind: "confirm-each" },
        threshold: { comparison: "at-or-below", amountOut: "1" },
        pollIntervalSeconds: 60,
        maxRuns: null,
      },
      20,
    );
    assert.equal(
      (await completeStrategy(directory, account, "watch-4", 21)).status,
      "completed",
    );
    const raw = await readFile(
      join(directory, "trade-strategies.json"),
      "utf8",
    );
    assert.ok(raw.includes('"schemaVersion":1'));
    await writeFile(
      join(directory, "trade-strategies.json"),
      JSON.stringify({
        schemaVersion: 1,
        account,
        strategies: [{ id: "bad" }],
      }),
    );
    await assert.rejects(() => listStrategies(directory, account));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
