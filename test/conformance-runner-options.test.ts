import assert from "node:assert/strict";
import test from "node:test";
import { resolve } from "node:path";
import {
  isCanonicalSherwoodOrigin,
  parseConformanceArguments,
  parseTrxResults,
  parseTrxResult,
  sherwoodDeterministicBuildProperties,
  SHERWOOD_PROCESS_TEST_FQNS,
} from "../scripts/conformance-runner-options.mjs";

const commit = "6f5739c5".repeat(5);
const output = resolve("gossip-v2-acceptance");
const sherwoodRepository = resolve("sherwood");

test("maps clean Sherwood builds to one deterministic source root", () => {
  assert.deepEqual(sherwoodDeterministicBuildProperties(sherwoodRepository), [
    "-p:ContinuousIntegrationBuild=true",
    `-p:PathMap=${sherwoodRepository}=/_/`,
  ]);
});

test("parses an exact local Sherwood source and commit in either option order", () => {
  assert.deepEqual(
    parseConformanceArguments([
      "--sherwood-commit",
      commit,
      "--output",
      output,
      "--sherwood-repository",
      sherwoodRepository,
    ]),
    {
      output,
      sherwoodRepository,
      sherwoodCommit: commit,
    },
  );
});

test("rejects incomplete or ambiguous Sherwood options", () => {
  assert.throws(
    () =>
      parseConformanceArguments([
        "--output",
        output,
        "--sherwood-commit",
        commit,
      ]),
    /repository/i,
  );
  assert.throws(
    () =>
      parseConformanceArguments([
        "--output",
        output,
        "--sherwood-repository",
        sherwoodRepository,
      ]),
    /commit/i,
  );
  assert.throws(
    () =>
      parseConformanceArguments([
        "--output",
        output,
        "--sherwood-commit",
        commit.toUpperCase(),
        "--sherwood-repository",
        sherwoodRepository,
      ]),
    /commit/i,
  );
  assert.throws(
    () => parseConformanceArguments(["--output", output, "--unknown", "value"]),
    /usage/i,
  );
  assert.throws(
    () =>
      parseConformanceArguments([
        "--output",
        output,
        "--sherwood-repository",
        "relative/sherwood",
        "--sherwood-commit",
        commit,
      ]),
    /absolute/i,
  );
  assert.throws(
    () => parseConformanceArguments(["--output", output, "--output", output]),
    /usage/i,
  );
  assert.throws(
    () =>
      parseConformanceArguments([
        "--output",
        output,
        "--sherwood-repository",
        sherwoodRepository,
        "--sherwood-repository",
        sherwoodRepository,
        "--sherwood-commit",
        commit,
      ]),
    /absolute/i,
  );
  assert.throws(
    () =>
      parseConformanceArguments([
        "--output",
        output,
        "--sherwood-repository",
        sherwoodRepository,
        "--sherwood-commit",
        commit,
        "--sherwood-commit",
        commit,
      ]),
    /commit/i,
  );
});

test("accepts only canonical Sherwood HTTPS and SSH origins", () => {
  for (const origin of [
    "https://github.com/gossip-dev/sherwood",
    "https://github.com/gossip-dev/sherwood.git",
    "git@github.com:gossip-dev/sherwood.git",
    "ssh://git@github.com/gossip-dev/sherwood.git",
  ]) {
    assert.equal(isCanonicalSherwoodOrigin(origin), true, origin);
  }
  for (const origin of [
    "https://user:password@github.com/gossip-dev/sherwood",
    "https://github.com/gossip-dev/other",
    "file:///tmp/sherwood",
  ]) {
    assert.equal(isCanonicalSherwoodOrigin(origin), false, origin);
  }
});

test("accepts the xUnit TRX counter shape without an optional skipped attribute", () => {
  const fqn =
    "Sherwood.Tests.GossipV2ProcessConformanceTests.A_real_process_serves_signed_http_and_mcp_and_replays_after_restart";
  const trx = `
    <TestMethod className="Sherwood.Tests.GossipV2ProcessConformanceTests" name="A_real_process_serves_signed_http_and_mcp_and_replays_after_restart" />
    <UnitTestResult testName="${fqn}" outcome="Passed" />
    <Counters total="1" executed="1" passed="1" failed="0" error="0" notExecuted="0" />`;

  assert.deepEqual(parseTrxResult(trx, fqn), {
    total: 1,
    executed: 1,
    passed: 1,
    failed: 0,
    error: 0,
    notExecuted: 0,
    skipped: 0,
  });
  assert.throws(
    () => parseTrxResult(trx.replace('passed="1"', 'passed="0"'), fqn),
    /pass contract/i,
  );
});

test("requires all exact Sherwood process test outcomes in one TRX", () => {
  const testMethods = SHERWOOD_PROCESS_TEST_FQNS.map((fqn) => {
    const separator = fqn.lastIndexOf(".");
    return `    <TestMethod className="${fqn.slice(0, separator)}" name="${fqn.slice(separator + 1)}" />`;
  });
  const testResults = SHERWOOD_PROCESS_TEST_FQNS.map(
    (fqn) => `    <UnitTestResult testName="${fqn}" outcome="Passed" />`,
  );
  const testCount = SHERWOOD_PROCESS_TEST_FQNS.length;
  const trx = `
${testMethods.join("\n")}
${testResults.join("\n")}
    <Counters total="${testCount}" executed="${testCount}" passed="${testCount}" failed="0" error="0" notExecuted="0" skipped="0" />`;
  const [first, second] = SHERWOOD_PROCESS_TEST_FQNS;

  assert.deepEqual(parseTrxResults(trx, SHERWOOD_PROCESS_TEST_FQNS), {
    total: testCount,
    executed: testCount,
    passed: testCount,
    failed: 0,
    error: 0,
    notExecuted: 0,
    skipped: 0,
    tests: SHERWOOD_PROCESS_TEST_FQNS,
  });
  assert.throws(() => parseTrxResults(trx, [first]), /exact pass contract/i);

  const failed = trx.replace(
    `testName="${second}" outcome="Passed"`,
    `testName="${second}" outcome="Failed"`,
  );
  assert.throws(
    () => parseTrxResults(failed, SHERWOOD_PROCESS_TEST_FQNS),
    /exact pass contract/i,
  );

  const duplicate = trx.replace(
    `<UnitTestResult testName="${second}" outcome="Passed" />`,
    `<UnitTestResult testName="${first}" outcome="Passed" />`,
  );
  assert.throws(
    () => parseTrxResults(duplicate, SHERWOOD_PROCESS_TEST_FQNS),
    /exact pass contract/i,
  );
});
