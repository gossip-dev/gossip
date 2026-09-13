import assert from "node:assert/strict";
import test from "node:test";
import { parseSherwoodProcessCapture } from "../scripts/process-capture.mjs";

const digest = `sha256:${"1".repeat(64)}`;

function validCapture() {
  const fingerprint = () => ({ byte_length: 42, digest });
  return {
    artifacts: {
      canonical_request: fingerprint(),
      database_state: fingerprint(),
      diagnostics: fingerprint(),
      evidence_graph: fingerprint(),
      http_response: fingerprint(),
      mcp_response: fingerprint(),
      operation_response: fingerprint(),
      receipt_chain: fingerprint(),
      result: fingerprint(),
      telemetry: fingerprint(),
    },
    operation_id: "process-conformance",
    privacy: {
      canary_present: false,
      key_material_present: false,
      raw_payloads_present: false,
    },
    redaction_profile: "digests-and-counts-only",
    schema: "sherwood.gossip-v2-process-capture.v1",
    telemetry: {
      captured_event_count: 0,
      enabled: false,
      reason: "disabled-by-conformance-profile",
    },
    test:
      "Sherwood.Tests.GossipV2ProcessConformanceTests." +
      "A_real_process_serves_signed_http_and_mcp_and_replays_after_restart",
  };
}

test("accepts the canonical redacted Sherwood process capture", () => {
  const capture = validCapture();

  assert.deepEqual(
    parseSherwoodProcessCapture(JSON.stringify(capture)),
    capture,
  );
});

test("rejects noncanonical or incomplete process captures", () => {
  const pretty = `${JSON.stringify(validCapture(), null, 2)}\n`;
  assert.throws(
    () => parseSherwoodProcessCapture(pretty),
    /not canonical JSON/u,
  );

  const complete = validCapture();
  const { diagnostics: _diagnostics, ...remainingArtifacts } =
    complete.artifacts;
  const incomplete = { ...complete, artifacts: remainingArtifacts };
  assert.throws(
    () => parseSherwoodProcessCapture(JSON.stringify(incomplete)),
    /artifact set is incomplete/u,
  );
});

test("rejects transport mismatch and unsafe privacy results", () => {
  const mismatch = validCapture();
  mismatch.artifacts.mcp_response.digest = `sha256:${"2".repeat(64)}`;
  assert.throws(
    () => parseSherwoodProcessCapture(JSON.stringify(mismatch)),
    /not equivalent/u,
  );

  const unsafe = validCapture();
  unsafe.privacy.canary_present = true;
  assert.throws(
    () => parseSherwoodProcessCapture(JSON.stringify(unsafe)),
    /privacy result is invalid/u,
  );
});
