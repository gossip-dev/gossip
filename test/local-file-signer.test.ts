import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Wallet, verifyMessage } from "ethers";

const tsx = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
const entry = join(process.cwd(), "src", "local-file-signer.ts");

function run(
  args: string[],
  input: string,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr)),
    );
    child.stdin.end(input);
  });
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "gossip-local-signer-"));
  const wallet = Wallet.createRandom();
  const keyFile = join(directory, "key.txt");
  await writeFile(keyFile, wallet.privateKey, { mode: 0o600 });
  return { directory, wallet, keyFile };
}

async function invoke(
  keyFile: string,
  address: string,
  message: string,
  format = "raw-hex",
) {
  return run(
    [
      tsx,
      entry,
      "--key-file",
      keyFile,
      "--format",
      format,
      "--address",
      address,
    ],
    JSON.stringify({ version: 1, message }),
  );
}

test("signs approved prefixes and emits a verifiable signature", async () => {
  const f = await fixture();
  try {
    const message = "Gossip signer verification v1\nchallenge";
    const before = await readFile(f.keyFile, "utf8");
    const result = await invoke(f.keyFile, f.wallet.address, message);
    assert.equal(
      verifyMessage(message, JSON.parse(result.stdout).signature),
      f.wallet.address,
    );
    assert.equal(await readFile(f.keyFile, "utf8"), before);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("accepts explicit JSON key formats", async () => {
  const f = await fixture();
  try {
    for (const [format, field] of [
      ["json-privateKey", "privateKey"],
      ["json-private_key", "private_key"],
    ] as const) {
      const path = join(f.directory, `${format}.json`);
      await writeFile(path, JSON.stringify({ [field]: f.wallet.privateKey }), {
        mode: 0o600,
      });
      const message = "Sherwood request v1\nchallenge";
      const result = await invoke(path, f.wallet.address, message, format);
      assert.equal(
        verifyMessage(message, JSON.parse(result.stdout).signature),
        f.wallet.address,
      );
    }
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("rejects mismatched addresses, unsupported messages, and symlinked keys", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      invoke(
        f.keyFile,
        Wallet.createRandom().address,
        "Sherwood request v1\nchallenge",
      ),
      /does not match/,
    );
    await assert.rejects(
      invoke(f.keyFile, f.wallet.address, "arbitrary message"),
      /unsupported signing prefix/,
    );
    try {
      const link = join(f.directory, "link");
      await symlink(f.keyFile, link);
      await assert.rejects(
        invoke(link, f.wallet.address, "Sherwood request v1\nchallenge"),
        /regular, non-symlink/,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("rejects group-readable Linux key files without changing permissions", async (t) => {
  if (process.platform !== "linux")
    return t.skip("Linux permission policy only");
  const f = await fixture();
  try {
    await chmod(f.keyFile, 0o640);
    const before = (await stat(f.keyFile)).mode & 0o777;
    await assert.rejects(
      invoke(f.keyFile, f.wallet.address, "Sherwood request v1\nchallenge"),
      /owner-only/,
    );
    assert.equal((await stat(f.keyFile)).mode & 0o777, before);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});
