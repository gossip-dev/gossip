import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GossipKit, type Engine } from "../src/kit.js";

test("connection is confirmed only by a valid engine access response for this wallet", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gossip-kit-"));
  const address = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
  let response: unknown = {
    wallet: address,
    standard_remaining: 5,
    enriched_remaining: 0,
    monetary_enabled: false,
  };
  const engine: Engine = { call: async () => response };
  const kit = new GossipKit(directory, address, engine, {
    dailyCreditBudget: 0,
    submissionKinds: [],
  });
  try {
    assert.equal((await kit.access()).wallet, address);
    response = { wallet: "0x0000000000000000000000000000000000000001" };
    await assert.rejects(kit.access(), /access response/);
  } finally {
    kit.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a legacy consultation cannot spend without a budget and a retry reuses the reserved operation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gossip-kit-"));
  const address = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
  let attempts = 0;
  const engine: Engine = {
    call: async (_tool, args) => {
      attempts++;
      if (attempts === 1) throw new Error("timeout");
      return { client_id: args.client_id, tier: "enriched", analysis: {} };
    },
  };
  let kit = new GossipKit(directory, address, engine, {
    dailyCreditBudget: 0,
    submissionKinds: [],
  });
  try {
    await assert.rejects(kit.consult("first", address), /budget/);
    assert.equal(attempts, 0);
    kit.close();
    kit = new GossipKit(directory, address, engine, {
      dailyCreditBudget: 1,
      submissionKinds: [],
    });
    await assert.rejects(kit.consult("first", address), /timeout/);
    kit.close();
    kit = new GossipKit(directory, address, engine, {
      dailyCreditBudget: 1,
      submissionKinds: [],
    });
    await assert.rejects(kit.consult("second", address), /budget/);
    assert.equal((await kit.consult("first", address)).tier, "enriched");
    assert.equal((await kit.consult("first", address)).tier, "enriched");
    assert.equal(attempts, 2);
    await assert.rejects(
      kit.consult("first", "0x0000000000000000000000000000000000000001"),
      /different/,
    );
  } finally {
    kit.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("submission permission is enforced before any engine call and authorized retries keep their receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gossip-kit-"));
  const address = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
  let calls = 0;
  const engine: Engine = {
    call: async () => {
      calls++;
      return {
        id: "f40c1427-2a60-4d03-b73f-1a72dcfa1d28",
        client_id: "discovery",
        status: "pending",
      };
    },
  };
  let kit = new GossipKit(directory, address, engine, {
    dailyCreditBudget: 0,
    submissionKinds: [],
  });
  const submission = {
    schema_version: 1,
    client_id: "discovery",
    chain_id: 4663,
    subject: address,
    kind: "token_discovery",
    observed_at: new Date().toISOString(),
    provenance: "observed",
  };
  try {
    await assert.rejects(kit.submit(submission), /permission/);
    assert.equal(calls, 0);
    kit.close();
    kit = new GossipKit(directory, address, engine, {
      dailyCreditBudget: 0,
      submissionKinds: ["token_discovery"],
    });
    const receipt = await kit.submit(submission);
    assert.deepEqual(await kit.submit(submission), receipt);
    assert.equal(calls, 1);
  } finally {
    kit.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("revoking a budget blocks an uncertain consultation retry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gossip-revoke-"));
  const address = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
  let calls = 0;
  const engine: Engine = {
    call: async () => {
      calls++;
      throw new Error("timeout");
    },
  };
  let kit = new GossipKit(directory, address, engine, {
    dailyCreditBudget: 1,
    submissionKinds: [],
  });
  try {
    await assert.rejects(kit.consult("pending", address), /timeout/);
    kit.close();
    kit = new GossipKit(directory, address, engine, {
      dailyCreditBudget: 0,
      submissionKinds: [],
    });
    await assert.rejects(kit.consult("pending", address), /budget/);
    assert.equal(calls, 1);
  } finally {
    kit.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent kit instances share a conservative credit reservation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gossip-parallel-"));
  const address = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
  let calls = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const engine: Engine = {
    call: async (_tool, args) => {
      calls++;
      await pending;
      return { client_id: args.client_id, tier: "enriched", analysis: {} };
    },
  };
  const first = new GossipKit(directory, address, engine, {
    dailyCreditBudget: 1,
    submissionKinds: [],
  });
  const second = new GossipKit(directory, address, engine, {
    dailyCreditBudget: 1,
    submissionKinds: [],
  });
  try {
    const accepted = first.consult("one", address);
    await assert.rejects(second.consult("two", address), /budget/);
    release();
    await accepted;
    assert.equal(calls, 1);
  } finally {
    release();
    first.close();
    second.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("submission responses must bind the submitted logical identity", async () => {
  const directory = await mkdtemp(join(tmpdir(), "gossip-receipt-"));
  const address = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
  const kit = new GossipKit(
    directory,
    address,
    {
      call: async () => ({
        id: "f40c1427-2a60-4d03-b73f-1a72dcfa1d28",
        client_id: "different",
        status: "pending",
      }),
    },
    { dailyCreditBudget: 0, submissionKinds: ["token_discovery"] },
  );
  try {
    await assert.rejects(
      kit.submit({
        schema_version: 1,
        client_id: "expected",
        chain_id: 4663,
        subject: address,
        kind: "token_discovery",
        observed_at: new Date().toISOString(),
        provenance: "observed",
      }),
      /receipt response/,
    );
  } finally {
    kit.close();
    await rm(directory, { recursive: true, force: true });
  }
});
