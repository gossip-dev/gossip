#!/usr/bin/env node

import { lstat, open } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Wallet, getAddress } from "ethers";

const MAX_KEY_FILE_BYTES = 16 * 1024;
const MAX_REQUEST_BYTES = 128 * 1024;
const GOSSIP_SIGNING_MESSAGE_PREFIXES = [
  "Sherwood request v1\n",
  "Gossip signer verification v1\n",
  "Gossip request v2\n",
] as const;
const FORMATS = ["raw-hex", "json-privateKey", "json-private_key"] as const;
type KeyFormat = (typeof FORMATS)[number];

export function isSupportedGossipSigningMessage(
  message: unknown,
): message is string {
  return (
    typeof message === "string" &&
    GOSSIP_SIGNING_MESSAGE_PREFIXES.some((prefix) => message.startsWith(prefix))
  );
}

export type SignerArguments = {
  keyFile: string;
  format: KeyFormat;
  address: string;
};

function usage(): string {
  return "Usage: node dist/local-file-signer.js --key-file ABSOLUTE --format raw-hex|json-privateKey|json-private_key --address CHECKSUM";
}

export function parseArguments(argv: string[]): SignerArguments {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      !flag?.startsWith("--") ||
      !value ||
      value.startsWith("--") ||
      values.has(flag)
    )
      throw new Error(usage());
    values.set(flag, value);
    index += 1;
  }
  if (
    values.size !== 3 ||
    !values.has("--key-file") ||
    !values.has("--format") ||
    !values.has("--address")
  )
    throw new Error(usage());
  const format = values.get("--format") as string;
  if (!(FORMATS as readonly string[]).includes(format))
    throw new Error("unsupported key format");
  const keyFile = values.get("--key-file") as string;
  if (!isAbsolute(keyFile))
    throw new Error("--key-file must be an absolute path");
  return {
    keyFile: resolve(keyFile),
    format: format as KeyFormat,
    address: values.get("--address") as string,
  };
}

async function readPrivateKey({
  keyFile,
  format,
}: Pick<SignerArguments, "keyFile" | "format">): Promise<string> {
  let metadata;
  try {
    metadata = await lstat(keyFile);
  } catch {
    throw new Error("key file cannot be read");
  }
  if (metadata.isSymbolicLink() || !metadata.isFile())
    throw new Error("key file must be a regular, non-symlink file");
  if (metadata.size > MAX_KEY_FILE_BYTES)
    throw new Error("key file exceeds the 16 KiB limit");
  if (process.platform === "linux" && (metadata.mode & 0o077) !== 0)
    throw new Error(
      "key file permissions must be owner-only (0600 or stricter)",
    );

  let content: string;
  try {
    const handle = await open(
      keyFile,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const actual = await handle.stat();
      if (
        !actual.isFile() ||
        actual.dev !== metadata.dev ||
        actual.ino !== metadata.ino ||
        actual.size > MAX_KEY_FILE_BYTES ||
        (process.platform === "linux" && (actual.mode & 0o077) !== 0)
      )
        throw new Error();
      const buffer = Buffer.alloc(MAX_KEY_FILE_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_KEY_FILE_BYTES) throw new Error();
      content = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    throw new Error("key file cannot be read");
  }
  if (format === "raw-hex") {
    if (!/^0x[0-9a-fA-F]{64}$/.test(content.trim()))
      throw new Error(
        "raw-hex key file must contain exactly one 32-byte hexadecimal key",
      );
    return content.trim();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("key file is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null)
    throw new Error("key file JSON must be an object");
  const field = format === "json-privateKey" ? "privateKey" : "private_key";
  const value = (parsed as Record<string, unknown>)[field];
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value))
    throw new Error(`key file JSON must contain a valid ${field}`);
  return value;
}

async function readRequest(): Promise<{ version: 1; message: string }> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > MAX_REQUEST_BYTES)
      throw new Error("signing request exceeds the 128 KiB limit");
    chunks.push(bytes);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("stdin must contain one JSON signing request");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as Record<string, unknown>).version !== 1 ||
    typeof (parsed as Record<string, unknown>).message !== "string"
  )
    throw new Error("signing request must be {version:1,message:string}");
  const message = (parsed as { message: string }).message;
  if (!isSupportedGossipSigningMessage(message))
    throw new Error("message has an unsupported signing prefix");
  return { version: 1, message };
}

export async function signRequest(
  args: SignerArguments,
): Promise<{ signature: string }> {
  let expectedAddress: string;
  try {
    expectedAddress = getAddress(args.address);
  } catch {
    throw new Error("--address must be a valid checksummed Ethereum address");
  }
  if (args.address !== expectedAddress)
    throw new Error("--address must use checksum casing");
  const privateKey = await readPrivateKey(args);
  let wallet: Wallet;
  try {
    wallet = new Wallet(privateKey);
  } catch {
    throw new Error("key file does not contain a usable private key");
  }
  if (getAddress(wallet.address) !== expectedAddress)
    throw new Error("key file address does not match --address");
  const request = await readRequest();
  try {
    return { signature: await wallet.signMessage(request.message) };
  } catch {
    throw new Error("signing failed");
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    console.log(
      JSON.stringify(await signRequest(parseArguments(process.argv.slice(2)))),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "signing failed");
    process.exitCode = 1;
  }
}

export async function loadLocalWallet(args: SignerArguments): Promise<Wallet> {
  const wallet = new Wallet(await readPrivateKey(args));
  if (getAddress(wallet.address) !== getAddress(args.address))
    throw new Error("key file address does not match selected wallet");
  return wallet;
}
