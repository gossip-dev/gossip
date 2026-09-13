import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  createCredentialStore,
  credentialId,
} from "../src/credential-store.js";
import { WalletVault } from "../src/wallet.js";

test("Linux Secret Service stores and removes an identity credential", async (t) => {
  if (process.platform !== "linux") {
    t.skip("Linux Secret Service acceptance runs on Linux only");
    return;
  }

  const directory = await mkdtemp(join(tmpdir(), "gossip-secret-service-"));
  const store = createCredentialStore(directory);
  const vault = new WalletVault(directory, store);
  const id = credentialId(directory);

  try {
    assert.equal(await store.read(id), null);

    const first = await vault.create();
    const second = await vault.create();

    assert.deepEqual(second, first);

    await assert.rejects(() => access(join(directory, "config.yaml")), {
      code: "ENOENT",
    });

    const protectedKey = await store.read(id);
    assert.ok(
      typeof protectedKey === "string" &&
        /^0x[0-9a-f]{64}$/i.test(protectedKey),
      "the credential store should return the protected wallet key",
    );

    await store.remove(id);
    assert.equal(await store.read(id), null);
    await assert.rejects(() => vault.identity(), /protected key is missing/);
  } finally {
    await store.remove(id);
    await rm(directory, { recursive: true, force: true });
  }
});
