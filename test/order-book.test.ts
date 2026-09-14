import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cancelOrder,
  createOrder,
  isLimitReached,
  isOrderReachable,
  listOrders,
  setOrderReadiness,
  summarizeOrders,
} from "../src/order-book.js";

const account = "0x0000000000000000000000000000000000000001";
const tokenIn = "0x0000000000000000000000000000000000000002";
const tokenOut = "0x0000000000000000000000000000000000000003";

test("creates, lists, summarizes, and cancels durable local intent orders", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gossip-orders-"));

  try {
    const market = await createOrder(directory, {
      id: "market-buy-1",
      side: "buy",
      type: "market",
      tokenIn,
      tokenOut,
      amountIn: "1000",
      slippageBps: 100,
      deadlineSeconds: 120,
      account,
    });
    const limit = await createOrder(directory, {
      id: "limit-sell-1",
      side: "sell",
      type: "limit",
      tokenIn,
      tokenOut,
      amountIn: "2000",
      limitPrice: "1.25",
      fee: 500,
      slippageBps: 50,
      deadlineSeconds: 180,
      account,
    });
    await createOrder(directory, {
      id: "market-sell-1",
      side: "sell",
      type: "market",
      tokenIn,
      tokenOut,
      amountIn: "3000",
      fee: 3000,
      slippageBps: 75,
      deadlineSeconds: 120,
      account,
    });
    await createOrder(directory, {
      id: "limit-buy-1",
      side: "buy",
      type: "limit",
      tokenIn,
      tokenOut,
      amountIn: "4000",
      limitPrice: "0.75",
      fee: 3000,
      slippageBps: 25,
      deadlineSeconds: 120,
      account,
    });

    assert.equal(market.status, "open");
    assert.equal(market.limitPrice, null);
    assert.equal(market.fee, undefined);
    assert.equal(limit.limitPrice, "1.25");
    assert.equal(limit.fee, 500);
    assert.deepEqual(
      (await listOrders(directory, { side: "sell" })).map((order) => order.id),
      ["limit-sell-1", "market-sell-1"],
    );
    assert.deepEqual(await summarizeOrders(directory), {
      total: 4,
      open: 4,
      ready: 0,
      cancelled: 0,
      filled: 0,
      expired: 0,
    });

    assert.equal(
      (await setOrderReadiness(directory, "limit-buy-1", true)).status,
      "ready",
    );
    assert.equal(
      (await setOrderReadiness(directory, "limit-buy-1", false)).status,
      "open",
    );

    const cancelled = await cancelOrder(directory, "limit-sell-1");
    assert.equal(cancelled.status, "cancelled");
    assert.deepEqual(await summarizeOrders(directory), {
      total: 4,
      open: 3,
      ready: 0,
      cancelled: 1,
      filled: 0,
      expired: 0,
    });
    const orderBookStats = await stat(join(directory, "orders.json"));
    assert.equal(orderBookStats.isFile(), true);
    if (process.platform !== "win32") {
      assert.equal(orderBookStats.mode & 0o077, 0);
    }
    assert.deepEqual(
      (await readdir(directory)).filter((name) => name.endsWith(".tmp")),
      [],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects duplicate IDs, invalid limits, and cancellation of terminal orders", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gossip-orders-"));
  const input = {
    id: "limit-buy-1",
    side: "buy" as const,
    type: "limit" as const,
    tokenIn,
    tokenOut,
    amountIn: "1000",
    limitPrice: "2.5",
    fee: 3000,
    slippageBps: 100,
    deadlineSeconds: 120,
    account,
  };

  try {
    await createOrder(directory, input);
    await assert.rejects(
      () => createOrder(directory, input),
      /already exists/i,
    );
    await cancelOrder(directory, input.id);
    await assert.rejects(
      () => cancelOrder(directory, input.id),
      /cannot be cancelled/i,
    );
    await assert.rejects(
      () =>
        createOrder(directory, {
          ...input,
          id: "missing-price",
          limitPrice: undefined,
        }),
      /limitPrice/i,
    );
    await assert.rejects(
      () =>
        createOrder(directory, {
          ...input,
          id: "different-account",
          account: "0x0000000000000000000000000000000000000004",
        }),
      /different account/i,
    );
    const normalized = await createOrder(directory, {
      ...input,
      id: "normalized-price",
      limitPrice: "2.5000",
    });
    assert.equal(normalized.limitPrice, "2.5");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("compares quoted output to the exact tokenOut-per-tokenIn limit", () => {
  assert.equal(isLimitReached("1250", "1000", "1.25"), true);
  assert.equal(isLimitReached("1249", "1000", "1.25"), false);
  assert.equal(isLimitReached("1", "3", "0.333333333333333333"), true);
  assert.equal(
    isOrderReachable(
      { type: "market", amountIn: "1000", limitPrice: null },
      "1",
    ),
    true,
  );
});

test("fails closed when the persisted order book is malformed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gossip-orders-"));

  try {
    await writeFile(
      join(directory, "orders.json"),
      JSON.stringify({ schemaVersion: 1, orders: [{ id: "partial" }] }),
    );
    await assert.rejects(() => listOrders(directory));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses an update that would make the order book unreadable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gossip-orders-"));
  const path = join(directory, "orders.json");
  const candidates = Array.from({ length: 10_000 }, (_, index) => ({
    schemaVersion: 1,
    id: `order-${String(index).padStart(58, "0")}`,
    side: "buy",
    type: "market",
    tokenIn,
    tokenOut,
    amountIn: "1",
    limitPrice: null,
    fee: 3000,
    slippageBps: 100,
    deadlineSeconds: 120,
    account,
    status: "open",
    createdAt: 1,
    updatedAt: 1,
  }));

  try {
    let low = 0;
    let high = candidates.length;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      const bytes = Buffer.byteLength(
        JSON.stringify({
          schemaVersion: 1,
          orders: candidates.slice(0, middle),
        }),
        "utf8",
      );
      if (bytes <= 1024 * 1024) low = middle;
      else high = middle;
    }
    const orders = candidates.slice(0, low);
    const original = JSON.stringify({ schemaVersion: 1, orders });
    await writeFile(path, original);

    await assert.rejects(
      () =>
        createOrder(directory, {
          id: "z".repeat(64),
          side: "sell",
          type: "limit",
          tokenIn,
          tokenOut,
          amountIn: "9".repeat(77),
          limitPrice: `${"9".repeat(77)}.${"9".repeat(18)}`,
          fee: 10_000,
          slippageBps: 9_999,
          deadlineSeconds: 300,
          account,
        }),
      /exceeds size limit/i,
    );
    assert.equal(await readFile(path, "utf8"), original);
    assert.equal((await listOrders(directory)).length, orders.length);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
