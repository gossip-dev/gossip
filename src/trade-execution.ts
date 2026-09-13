import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import {
  Interface,
  getAddress,
  keccak256,
  Transaction,
  type JsonRpcProvider,
} from "ethers";
import { z } from "zod";
import { WalletVault } from "./wallet.js";
import { createCredentialStore } from "./credential-store.js";
import { createNetworkProvider } from "./network.js";
import {
  buildSwapTransaction,
  SWAP_ROUTER02,
  QUOTER_V2,
  V3_FACTORY,
  verifyDexDeployment,
} from "./dex.js";

const uint = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,77})$/)
  .refine((value) => BigInt(value) < 2n ** 256n);
const address = z.string().transform((value) => getAddress(value));
const quoteSchema = z
  .object({
    chainId: z.literal("4663"),
    account: address,
    router: address,
    tokenIn: address,
    tokenOut: address,
    fee: z.union([
      z.literal(100),
      z.literal(500),
      z.literal(3000),
      z.literal(10000),
    ]),
    amountIn: uint,
    quotedAmountOut: uint,
    amountOutMinimum: uint,
    deadline: uint,
    quoter: address,
    factory: address,
    pool: address,
    transaction: z
      .object({ to: address, data: z.string(), value: z.literal("0") })
      .strict(),
    executionAuthorized: z.literal(false),
  })
  .strict();
export const permissionSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
    enabled: z.boolean(),
    quote: quoteSchema,
    gasLimit: uint,
    maxFeePerGas: uint,
  })
  .strict();
type Permission = z.infer<typeof permissionSchema>;
type SentTransaction = { raw: string; hash: string; nonce: number };
type RecordEntry = {
  fingerprint: string;
  approval?: SentTransaction;
  swap?: SentTransaction;
};
type Journal = Record<string, RecordEntry>;
const token = new Interface([
  "function allowance(address,address) view returns(uint256)",
  "function balanceOf(address) view returns(uint256)",
  "function approve(address,uint256) returns(bool)",
]);

export async function readPermission(directory: string): Promise<Permission> {
  return permissionSchema.parse(
    JSON.parse(
      await readFile(join(directory, "trade-permission.json"), "utf8"),
    ),
  );
}

export function validatePermission(permission: Permission): void {
  const q = permission.quote;
  if (
    q.router !== getAddress(SWAP_ROUTER02) ||
    q.quoter !== getAddress(QUOTER_V2) ||
    q.factory !== getAddress(V3_FACTORY) ||
    q.tokenIn === q.tokenOut ||
    BigInt(q.amountIn) === 0n ||
    BigInt(q.amountOutMinimum) === 0n ||
    BigInt(q.amountOutMinimum) > BigInt(q.quotedAmountOut)
  )
    throw new Error("Invalid trade bounds");
  if (
    BigInt(permission.gasLimit) === 0n ||
    BigInt(permission.maxFeePerGas) === 0n
  )
    throw new Error("Gas bounds must be positive");
  const expected = swapTransaction(permission);
  if (q.transaction.to !== expected.to || q.transaction.data !== expected.data)
    throw new Error("Quote transaction differs from the approved trade");
}
function swapTransaction(permission: Permission) {
  const q = permission.quote;
  return buildSwapTransaction({
    tokenIn: q.tokenIn,
    tokenOut: q.tokenOut,
    fee: q.fee,
    recipient: q.account,
    amountIn: BigInt(q.amountIn),
    amountOutMinimum: BigInt(q.amountOutMinimum),
    deadline: BigInt(q.deadline),
  });
}

export async function withTradeLock<T>(
  directory: string,
  action: () => Promise<T>,
): Promise<T> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, "trade.lock");
  const lock = await open(path, "wx", 0o600);
  try {
    return await action();
  } finally {
    await lock.close();
    await rm(path, { force: true });
  }
}
export async function writeTradeFile(
  directory: string,
  name: string,
  value: unknown,
): Promise<void> {
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, join(directory, name));
  } finally {
    await rm(temporary, { force: true });
  }
}
async function readJournal(directory: string): Promise<Journal> {
  try {
    return JSON.parse(
      await readFile(join(directory, "trades.json"), "utf8"),
    ) as Journal;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export async function executeTrade(
  directory: string,
  id: string,
): Promise<unknown> {
  return withTradeLock(directory, async () => {
    const permission = await readPermission(directory);
    validatePermission(permission);
    if (permission.id !== id)
      throw new Error("Trade permission does not match operation");
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ ...permission, enabled: true }))
      .digest("hex");
    const journal = await readJournal(directory);
    const entry = journal[id] ?? { fingerprint };
    if (entry.fingerprint !== fingerprint)
      throw new Error("Operation ID already represents another trade");
    const provider = await createNetworkProvider(directory);
    try {
      await verifyDexDeployment(provider);
      if (entry.swap) return await resume(entry.swap, "swap");
      for (const [otherId, other] of Object.entries(journal)) {
        if (otherId === id) continue;
        const transaction = other.swap ?? other.approval;
        if (
          !transaction ||
          !["confirmed", "reverted"].includes(
            (await receiptStatus(provider, transaction)).status,
          )
        )
          throw new Error(
            "Reconcile the previous trade before starting another",
          );
      }
      if (
        !permission.enabled ||
        BigInt(permission.quote.deadline) <=
          BigInt(Math.floor(Date.now() / 1000))
      ) {
        if (entry.approval)
          return {
            ...(await receiptStatus(provider, entry.approval)),
            phase: "approval",
            executionAuthorized: false,
          };
        throw new Error("Trade permission revoked or expired");
      }
      const vault = new WalletVault(
        directory,
        createCredentialStore(directory),
      );
      const signer = await vault.transactionSigner();
      if (signer.address !== permission.quote.account)
        throw new Error("Selected trading wallet does not match permission");
      const q = permission.quote;
      const balanceData = token.encodeFunctionData("balanceOf", [q.account]);
      const inputBalance = token.decodeFunctionResult(
        "balanceOf",
        await provider.call({ to: q.tokenIn, data: balanceData }),
      )[0] as bigint;
      if (inputBalance < BigInt(q.amountIn))
        throw new Error("Insufficient input token balance");
      if (entry.approval) {
        const approval = await resume(entry.approval, "approval");
        if (approval.status !== "confirmed") return approval;
      } else {
        const data = token.encodeFunctionData("allowance", [
          q.account,
          SWAP_ROUTER02,
        ]);
        const allowance = token.decodeFunctionResult(
          "allowance",
          await provider.call({ to: q.tokenIn, data }),
        )[0] as bigint;
        if (allowance < BigInt(q.amountIn)) {
          if (allowance !== 0n)
            throw new Error(
              "Existing allowance must be reset by the owner before this trade",
            );
          const transaction = {
            to: q.tokenIn,
            data: token.encodeFunctionData("approve", [
              SWAP_ROUTER02,
              q.amountIn,
            ]),
            value: 0n,
          };
          entry.approval = await sign(transaction);
          journal[id] = entry;
          await writeTradeFile(directory, "trades.json", journal);
          return await broadcast(provider, entry.approval);
        }
      }
      entry.swap = await sign(swapTransaction(permission));
      journal[id] = entry;
      await writeTradeFile(directory, "trades.json", journal);
      return await broadcast(provider, entry.swap);

      async function resume(sent: SentTransaction, kind: "approval" | "swap") {
        const expected =
          kind === "swap"
            ? swapTransaction(permission)
            : {
                to: permission.quote.tokenIn,
                data: token.encodeFunctionData("approve", [
                  SWAP_ROUTER02,
                  permission.quote.amountIn,
                ]),
                value: 0n,
              };
        const parsed = Transaction.from(sent.raw);
        if (
          parsed.hash !== sent.hash ||
          parsed.from !== permission.quote.account ||
          parsed.to !== expected.to ||
          parsed.data !== expected.data ||
          parsed.value !== 0n ||
          parsed.chainId !== 4663n ||
          parsed.nonce !== sent.nonce ||
          parsed.gasLimit > BigInt(permission.gasLimit) ||
          parsed.maxFeePerGas === null ||
          parsed.maxFeePerGas > BigInt(permission.maxFeePerGas)
        )
          throw new Error("Recorded transaction differs from permission");
        const status = await receiptStatus(provider, sent);
        if (status.status !== "pending" && status.status !== "reorg")
          return status;
        if (
          !permission.enabled ||
          BigInt(permission.quote.deadline) <=
            BigInt(Math.floor(Date.now() / 1000))
        )
          return {
            ...status,
            nextStep:
              "Permission revoked or expired; reconciliation is read-only.",
          };
        await assertCurrentPermission();
        return broadcast(provider, sent);
      }

      async function assertCurrentPermission() {
        const latest = await readPermission(directory);
        if (
          !latest.enabled ||
          createHash("sha256")
            .update(JSON.stringify({ ...latest, enabled: true }))
            .digest("hex") !== fingerprint ||
          BigInt(permission.quote.deadline) <=
            BigInt(Math.floor(Date.now() / 1000))
        )
          throw new Error("Trade authorization changed");
      }

      async function sign(transaction: {
        to: string;
        data: string;
        value: bigint;
      }): Promise<SentTransaction> {
        await assertCurrentPermission();
        if (BigInt(await provider.send("eth_chainId", [])) !== 4663n)
          throw new Error("Wrong transaction chain");
        await provider.call({ ...transaction, from: q.account });
        const estimated = await provider.estimateGas({
          ...transaction,
          from: q.account,
        });
        const gasLimit = (estimated * 120n) / 100n;
        if (gasLimit > BigInt(permission.gasLimit))
          throw new Error("Gas estimate exceeds permission");
        const fees = await provider.getFeeData();
        if (
          fees.maxFeePerGas === null ||
          fees.maxPriorityFeePerGas === null ||
          fees.maxFeePerGas > BigInt(permission.maxFeePerGas) ||
          fees.maxPriorityFeePerGas > fees.maxFeePerGas
        )
          throw new Error(
            "Gas price exceeds permission or fee model unsupported",
          );
        if (
          (await provider.getBalance(q.account)) <
          gasLimit * fees.maxFeePerGas
        )
          throw new Error("Insufficient ETH for gas");
        const nonce = await provider.getTransactionCount(q.account, "pending");
        await assertCurrentPermission();
        const raw = await signer.signTransaction({
          ...transaction,
          chainId: 4663,
          type: 2,
          nonce,
          gasLimit,
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        });
        return { raw, hash: keccak256(raw), nonce };
      }
    } finally {
      provider.destroy();
    }
  });
}
async function receiptStatus(provider: JsonRpcProvider, tx: SentTransaction) {
  if (Transaction.from(tx.raw).hash !== tx.hash)
    throw new Error("Transaction journal mismatch");
  const receipt = await provider.getTransactionReceipt(tx.hash);
  if (!receipt) return { status: "pending", transactionHash: tx.hash };
  const block = await provider.getBlock(receipt.blockNumber);
  if (block?.hash !== receipt.blockHash)
    return { status: "reorg", transactionHash: tx.hash };
  return {
    status: receipt.status === 1 ? "confirmed" : "reverted",
    transactionHash: tx.hash,
    blockNumber: receipt.blockNumber,
  };
}
async function broadcast(provider: JsonRpcProvider, tx: SentTransaction) {
  try {
    await provider.broadcastTransaction(tx.raw);
  } catch {
    return {
      status: "pending",
      transactionHash: tx.hash,
      nextStep:
        "Retry this operation ID to reconcile the recorded transaction; do not create a new trade.",
    };
  }
  return receiptStatus(provider, tx);
}

export async function permissionCanBeReplaced(
  directory: string,
  id: string,
): Promise<boolean> {
  const journal = await readJournal(directory);
  const entry = journal[id];
  if (!entry) return true;
  const transaction = entry.swap ?? entry.approval;
  if (!transaction) return false;
  const provider = await createNetworkProvider(directory);
  try {
    const status = await receiptStatus(provider, transaction);
    return status.status === "confirmed" || status.status === "reverted";
  } finally {
    provider.destroy();
  }
}
