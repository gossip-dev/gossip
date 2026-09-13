import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { Wallet, getAddress } from "ethers";
import { WalletVault } from "../src/wallet.js";
import {
  createCredentialStore,
  credentialId,
} from "../src/credential-store.js";
import type { CredentialStore } from "../src/credential-store.js";

class MemoryStore implements CredentialStore {
  values = new Map<string, string>();
  failRemove = false;
  async read(id: string) {
    return this.values.get(id) ?? null;
  }
  async write(id: string, secret: string) {
    if (this.values.has(id)) throw new Error("overwrite");
    this.values.set(id, secret);
  }
  async remove(id: string) {
    if (this.failRemove) throw new Error("remove failed");
    this.values.delete(id);
  }
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "gossip-wallet-"));
  const store = new MemoryStore();
  return { directory, store, vault: new WalletVault(directory, store) };
}

test("create is idempotent and identity contains only a checksummed address", async () => {
  const f = await fixture();
  try {
    const first = await f.vault.create();
    const second = await f.vault.create();
    assert.deepEqual(second, first);
    assert.equal(first.address, getAddress(first.address));
    assert.deepEqual(await f.vault.identity(), first);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("missing protected key is a hard error and create does not replace it", async () => {
  const f = await fixture();
  try {
    await f.vault.create();
    f.store.values.clear();
    await assert.rejects(() => f.vault.create(), /protected key is missing/);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("keystore import validates address and does not overwrite an existing identity", async () => {
  const f = await fixture();
  const imported = Wallet.createRandom();
  try {
    const encrypted = await imported.encrypt("pw");
    await assert.rejects(
      () =>
        f.vault.importKeystore(encrypted, "pw", Wallet.createRandom().address),
      /does not match/,
    );
    await f.vault.importKeystore(
      await imported.encrypt("pw"),
      "pw",
      imported.address,
    );
    const other = Wallet.createRandom();
    const otherEncrypted = await other.encrypt("pw");
    await assert.rejects(
      () => f.vault.importKeystore(otherEncrypted, "pw", other.address),
      /different wallet identity/,
    );
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("backup is an encrypted keystore and remove is explicit", async () => {
  const f = await fixture();
  try {
    const identity = await f.vault.create();
    const backup = await f.vault.backup("backup-password");
    const restored = await Wallet.fromEncryptedJson(backup, "backup-password");
    assert.equal(getAddress(restored.address), identity.address);
    await f.vault.remove();
    await assert.rejects(() => f.vault.identity(), /not configured/);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("wrong password and wrong expected address leave the existing identity intact", async () => {
  const f = await fixture();
  const original = await f.vault.create();
  const other = Wallet.createRandom();
  try {
    const encrypted = await other.encrypt("correct");
    await assert.rejects(() =>
      f.vault.importKeystore(encrypted, "wrong", other.address),
    );
    await assert.rejects(
      () => f.vault.importKeystore(encrypted, "correct", original.address),
      /does not match/,
    );
    assert.deepEqual(await f.vault.identity(), original);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("corrupt profile fails closed", async () => {
  const f = await fixture();
  try {
    await f.vault.create();
    await writeFile(join(f.directory, "wallet.json"), "not-json");
    await assert.rejects(() => f.vault.identity(), /Unexpected token/);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("a failed removal leaves the profile and key together for a safe retry", async () => {
  const f = await fixture();
  try {
    const identity = await f.vault.create();
    f.store.failRemove = true;
    await assert.rejects(() => f.vault.remove(), /remove failed/);
    assert.deepEqual(await f.vault.identity(), identity);
    f.store.failRemove = false;
    await f.vault.remove();
    await assert.rejects(() => f.vault.identity(), /not configured/);
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test("credential identifiers are stable and the real protected store round-trips on Windows", async (t) => {
  const f = await fixture();
  assert.equal(credentialId(f.directory), credentialId(resolve(f.directory)));
  if (process.platform !== "win32") {
    t.skip("Windows DPAPI test");
    return;
  }
  const store = createCredentialStore(f.directory);
  const id = credentialId(f.directory);
  try {
    await store.write(id, "synthetic-secret");
    assert.equal(await store.read(id), "synthetic-secret");
  } finally {
    await store.remove(id);
    await rm(f.directory, { recursive: true, force: true });
  }
});
