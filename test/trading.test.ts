import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const run = promisify(execFile);

const account = "0x0000000000000000000000000000000000000001";
const tokenIn = "0x0000000000000000000000000000000000000002";
const tokenOut = "0x0000000000000000000000000000000000000003";

function trade(directory: string, args: string[]) {
  return run(process.execPath, [
    "node_modules/tsx/dist/cli.mjs",
    "src/cli.ts",
    "trade",
    ...args,
    "--directory",
    directory,
  ]);
}

async function writeExternalWalletProfile(directory: string): Promise<void> {
  await writeFile(
    join(directory, "wallet.json"),
    JSON.stringify({
      address: account,
      external: {
        keyFile: join(directory, "owner.key"),
        format: "raw-hex",
      },
    }),
  );
}

test("trading reports disabled without reading keys or creating state", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gossip-trade-"));
  try {
    const result = await run(process.execPath, [
      "node_modules/tsx/dist/cli.mjs",
      "src/cli.ts",
      "trade",
      "status",
      "--directory",
      directory,
    ]);
    assert.equal(JSON.parse(result.stdout).executionAuthorized, false);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("trade authorization refuses non-interactive confirmation without creating permission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gossip-trade-"));
  try {
    const result = await run(process.execPath, [
      "node_modules/tsx/dist/cli.mjs",
      "src/cli.ts",
      "trade",
      "authorize",
      "--directory",
      directory,
    ]).catch((error) => error);
    assert.match(result.stderr, /interactive terminal/i);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("trade autonomy CLI records confirm-each without granting standing authority", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gossip-trade-mode-"));
  try {
    assert.deepEqual(
      JSON.parse((await trade(directory, ["autonomy", "status"])).stdout),
      { mode: "choice-required", executionAuthorized: false },
    );
    assert.deepEqual(
      JSON.parse(
        (
          await trade(directory, [
            "autonomy",
            "choose",
            "--mode",
            "confirm-each",
          ])
        ).stdout,
      ),
      { mode: "confirm-each", executionAuthorized: false },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("trade order CLI creates, lists, summarizes, and cancels local intents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gossip-trade-order-"));

  try {
    await writeExternalWalletProfile(directory);
    const created = await trade(directory, [
      "order",
      "create",
      "--id",
      "limit-buy-1",
      "--side",
      "buy",
      "--type",
      "limit",
      "--token-in",
      tokenIn,
      "--token-out",
      tokenOut,
      "--amount-in",
      "1000",
      "--limit-price",
      "1.25",
      "--slippage-bps",
      "100",
      "--deadline-seconds",
      "120",
    ]);
    assert.deepEqual(JSON.parse(created.stdout), {
      order: {
        schemaVersion: 1,
        id: "limit-buy-1",
        side: "buy",
        type: "limit",
        tokenIn,
        tokenOut,
        amountIn: "1000",
        limitPrice: "1.25",
        fee: 3000,
        slippageBps: 100,
        deadlineSeconds: 120,
        account,
        status: "open",
        createdAt: JSON.parse(created.stdout).order.createdAt,
        updatedAt: JSON.parse(created.stdout).order.updatedAt,
      },
      executionAuthorized: false,
    });

    const listed = JSON.parse(
      (await trade(directory, ["order", "list", "--status", "open"])).stdout,
    );
    assert.equal(listed.orders.length, 1);
    assert.equal(listed.orders[0].id, "limit-buy-1");
    assert.deepEqual(
      JSON.parse((await trade(directory, ["order", "status"])).stdout),
      {
        total: 1,
        open: 1,
        ready: 0,
        cancelled: 0,
        filled: 0,
        expired: 0,
        executionAuthorized: false,
      },
    );
    assert.equal(
      JSON.parse(
        (await trade(directory, ["order", "cancel", "--id", "limit-buy-1"]))
          .stdout,
      ).order.status,
      "cancelled",
    );
    assert.equal(
      JSON.parse((await trade(directory, ["order", "status"])).stdout)
        .cancelled,
      1,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("trade order derives the account from the configured wallet", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gossip-trade-order-"));

  try {
    const result = await trade(directory, [
      "order",
      "create",
      "--id",
      "market-sell-1",
      "--side",
      "sell",
      "--type",
      "market",
      "--token-in",
      tokenIn,
      "--token-out",
      tokenOut,
      "--amount-in",
      "1000",
      "--slippage-bps",
      "100",
      "--deadline-seconds",
      "120",
    ]).catch((error) => error);

    assert.match(result.stderr, /wallet operation failed/i);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("trade watcher and DCA definitions are available through the CLI", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gossip-strategy-cli-"));
  try {
    await writeExternalWalletProfile(directory);
    await trade(directory, ["autonomy", "choose", "--mode", "confirm-each"]);
    const watcher = JSON.parse(
      (
        await trade(directory, [
          "watcher",
          "create",
          "--id",
          "price-watch",
          "--token-in",
          tokenIn,
          "--token-out",
          tokenOut,
          "--comparison",
          "at-or-above",
          "--amount-out",
          "1200",
          "--interval-seconds",
          "60",
          "--slippage-bps",
          "100",
        ])
      ).stdout,
    );
    assert.equal(watcher.strategy.kind, "watcher");
    assert.equal(watcher.executionAuthorized, false);

    const dca = JSON.parse(
      (
        await trade(directory, [
          "dca",
          "create",
          "--id",
          "daily-dca",
          "--token-in",
          tokenIn,
          "--token-out",
          tokenOut,
          "--amount-in",
          "1000",
          "--anchor-at",
          "1900000000",
          "--interval-seconds",
          "3600",
          "--max-runs",
          "10",
          "--slippage-bps",
          "100",
        ])
      ).stdout,
    );
    assert.equal(dca.strategy.kind, "dca");
    assert.equal(
      JSON.parse((await trade(directory, ["watcher", "list"])).stdout)
        .strategies.length,
      1,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
