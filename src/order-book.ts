import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAddress, isAddress } from "ethers";
import { z } from "zod";
import { withTradeLock, writeTradeFile } from "./trade-execution.js";

const ORDER_BOOK_FILE = "orders.json";
const MAX_ORDER_BOOK_BYTES = 1024 * 1024;
const PRICE_PATTERN = /^(?:0|[1-9][0-9]{0,77})(?:\.[0-9]{1,18})?$/;

const orderIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const addressSchema = z
  .string()
  .refine((value) => isAddress(value), "must be a valid EVM address")
  .transform((value) => getAddress(value));
const amountSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,77}$/, "must be positive integer base units")
  .refine((value) => BigInt(value) < 2n ** 256n, "must fit uint256");
const priceSchema = z
  .string()
  .regex(
    PRICE_PATTERN,
    "must be a plain decimal with at most 18 fractional digits",
  )
  .transform(normalizeDecimal)
  .refine((value) => decimalParts(value).numerator > 0n, "must be positive");
const feeSchema = z.union([
  z.literal(100),
  z.literal(500),
  z.literal(3000),
  z.literal(10000),
]);
const slippageSchema = z.number().int().min(0).max(9_999);
const deadlineSchema = z.number().int().min(1).max(300);

export const orderInputSchema = z
  .object({
    id: orderIdSchema,
    side: z.enum(["buy", "sell"]),
    type: z.enum(["market", "limit"]),
    tokenIn: addressSchema,
    tokenOut: addressSchema,
    amountIn: amountSchema,
    limitPrice: priceSchema.optional(),
    fee: feeSchema,
    slippageBps: slippageSchema,
    deadlineSeconds: deadlineSchema,
    account: addressSchema,
  })
  .strict()
  .superRefine((order, context) => {
    if (order.tokenIn === order.tokenOut) {
      context.addIssue({
        code: "custom",
        path: ["tokenOut"],
        message: "tokenOut must differ from tokenIn",
      });
    }
    if (order.type === "limit" && order.limitPrice === undefined) {
      context.addIssue({
        code: "custom",
        path: ["limitPrice"],
        message: "limitPrice is required for limit orders",
      });
    }
    if (order.type === "market" && order.limitPrice !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["limitPrice"],
        message: "limitPrice is only valid for limit orders",
      });
    }
  });

const orderStatusSchema = z.enum([
  "open",
  "ready",
  "cancelled",
  "filled",
  "expired",
]);
const orderSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: orderIdSchema,
    side: z.enum(["buy", "sell"]),
    type: z.enum(["market", "limit"]),
    tokenIn: addressSchema,
    tokenOut: addressSchema,
    amountIn: amountSchema,
    limitPrice: priceSchema.nullable(),
    fee: feeSchema,
    slippageBps: slippageSchema,
    deadlineSeconds: deadlineSchema,
    account: addressSchema,
    status: orderStatusSchema,
    createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    updatedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .superRefine((order, context) => {
    if (order.tokenIn === order.tokenOut) {
      context.addIssue({
        code: "custom",
        path: ["tokenOut"],
        message: "tokenOut must differ from tokenIn",
      });
    }
    if (
      (order.type === "limit" && order.limitPrice === null) ||
      (order.type === "market" && order.limitPrice !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["limitPrice"],
        message: "limitPrice must match the order type",
      });
    }
    if (order.updatedAt < order.createdAt) {
      context.addIssue({
        code: "custom",
        path: ["updatedAt"],
        message: "updatedAt must not precede createdAt",
      });
    }
  });
const orderBookSchema = z
  .object({
    schemaVersion: z.literal(1),
    orders: z.array(orderSchema).max(10_000),
  })
  .strict()
  .superRefine((book, context) => {
    const ids = new Set<string>();
    for (const [index, order] of book.orders.entries()) {
      if (ids.has(order.id)) {
        context.addIssue({
          code: "custom",
          path: ["orders", index, "id"],
          message: "Order IDs must be unique",
        });
      }
      ids.add(order.id);
    }
  });

export type OrderInput = z.input<typeof orderInputSchema>;
export type LocalOrder = z.output<typeof orderSchema>;
export type OrderFilter = Partial<Pick<LocalOrder, "side" | "type" | "status">>;
export const orderFilterSchema = z
  .object({
    side: z.enum(["buy", "sell"]).optional(),
    type: z.enum(["market", "limit"]).optional(),
    status: orderStatusSchema.optional(),
  })
  .strict();

export async function createOrder(
  directory: string,
  input: OrderInput,
  now = Math.floor(Date.now() / 1000),
): Promise<LocalOrder> {
  const parsed = parseOrderInput(input);

  return withTradeLock(directory, async () => {
    const book = await readOrderBook(directory);
    if (book.orders.some((order) => order.account !== parsed.account)) {
      throw new Error("Order book belongs to a different account");
    }
    if (book.orders.some((order) => order.id === parsed.id)) {
      throw new Error(`Order ${parsed.id} already exists`);
    }

    const order = orderSchema.parse({
      schemaVersion: 1,
      ...parsed,
      limitPrice: parsed.limitPrice ?? null,
      status: "open",
      createdAt: now,
      updatedAt: now,
    });
    book.orders.push(order);
    await writeOrderBook(directory, book);

    return order;
  });
}

export async function listOrders(
  directory: string,
  filter: OrderFilter = {},
): Promise<LocalOrder[]> {
  const book = await readOrderBook(directory);
  const parsedFilter = parseOrderFilter(filter);

  return book.orders
    .filter(
      (order) =>
        (parsedFilter.side === undefined || order.side === parsedFilter.side) &&
        (parsedFilter.type === undefined || order.type === parsedFilter.type) &&
        (parsedFilter.status === undefined ||
          order.status === parsedFilter.status),
    )
    .sort(
      (left, right) =>
        left.createdAt - right.createdAt || compareIds(left.id, right.id),
    );
}

export async function summarizeOrders(directory: string): Promise<{
  total: number;
  open: number;
  ready: number;
  cancelled: number;
  filled: number;
  expired: number;
}> {
  const orders = await listOrders(directory);

  return {
    total: orders.length,
    open: orders.filter((order) => order.status === "open").length,
    ready: orders.filter((order) => order.status === "ready").length,
    cancelled: orders.filter((order) => order.status === "cancelled").length,
    filled: orders.filter((order) => order.status === "filled").length,
    expired: orders.filter((order) => order.status === "expired").length,
  };
}

export async function cancelOrder(
  directory: string,
  id: string,
  now = Math.floor(Date.now() / 1000),
): Promise<LocalOrder> {
  return updateOrder(directory, id, (order) => {
    if (order.status !== "open" && order.status !== "ready") {
      throw new Error(`Order ${id} cannot be cancelled from ${order.status}`);
    }

    return { ...order, status: "cancelled", updatedAt: now };
  });
}

export async function setOrderReadiness(
  directory: string,
  id: string,
  ready: boolean,
  now = Math.floor(Date.now() / 1000),
): Promise<LocalOrder> {
  return updateOrder(directory, id, (order) => {
    if (order.status !== "open" && order.status !== "ready") {
      throw new Error(`Order ${id} cannot be checked from ${order.status}`);
    }

    return { ...order, status: ready ? "ready" : "open", updatedAt: now };
  });
}

export function isLimitReached(
  quotedAmountOut: string,
  amountIn: string,
  limitPrice: string,
): boolean {
  const output = amountSchema.parse(quotedAmountOut);
  const input = amountSchema.parse(amountIn);
  const price = priceSchema.parse(limitPrice);
  const { numerator, denominator } = decimalParts(price);

  return BigInt(output) * denominator >= BigInt(input) * numerator;
}

export function isOrderReachable(
  order: Pick<LocalOrder, "amountIn" | "limitPrice" | "type">,
  quotedAmountOut: string,
): boolean {
  return (
    order.type === "market" ||
    isLimitReached(quotedAmountOut, order.amountIn, order.limitPrice!)
  );
}

async function updateOrder(
  directory: string,
  id: string,
  update: (order: LocalOrder) => LocalOrder,
): Promise<LocalOrder> {
  const parsedId = orderIdSchema.parse(id);

  return withTradeLock(directory, async () => {
    const book = await readOrderBook(directory);
    const index = book.orders.findIndex((order) => order.id === parsedId);
    if (index < 0) throw new Error(`Order ${parsedId} does not exist`);

    const order = orderSchema.parse(update(book.orders[index]!));
    book.orders[index] = order;
    await writeOrderBook(directory, book);

    return order;
  });
}

async function readOrderBook(directory: string) {
  try {
    const text = await readFile(join(directory, ORDER_BOOK_FILE), "utf8");
    if (Buffer.byteLength(text, "utf8") > MAX_ORDER_BOOK_BYTES) {
      throw new Error("Order book exceeds size limit");
    }

    return orderBookSchema.parse(JSON.parse(text));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { schemaVersion: 1 as const, orders: [] as LocalOrder[] };
    }
    throw error;
  }
}

async function writeOrderBook(
  directory: string,
  book: z.output<typeof orderBookSchema>,
): Promise<void> {
  const parsed = orderBookSchema.parse(book);
  if (
    Buffer.byteLength(JSON.stringify(parsed), "utf8") > MAX_ORDER_BOOK_BYTES
  ) {
    throw new Error("Order book exceeds size limit");
  }
  await writeTradeFile(directory, ORDER_BOOK_FILE, parsed);
}

function decimalParts(value: string): {
  numerator: bigint;
  denominator: bigint;
} {
  const [whole, fraction = ""] = value.split(".");
  const denominator = 10n ** BigInt(fraction.length);
  const numerator = BigInt(`${whole}${fraction}`);

  return { numerator, denominator };
}

function normalizeDecimal(value: string): string {
  const [whole, fraction] = value.split(".");
  const normalizedFraction = fraction?.replace(/0+$/, "");

  return normalizedFraction ? `${whole}.${normalizedFraction}` : whole!;
}

function parseOrderInput(input: OrderInput) {
  const result = orderInputSchema.safeParse(input);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid order: ${detail}`);
  }

  return result.data;
}

function parseOrderFilter(filter: OrderFilter) {
  const result = orderFilterSchema.safeParse(filter);
  if (!result.success) throw new Error("Invalid order filter");

  return result.data;
}

function compareIds(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
