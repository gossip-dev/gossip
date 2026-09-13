const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const PROCESS_TEST =
  "Sherwood.Tests.GossipV2ProcessConformanceTests." +
  "A_real_process_serves_signed_http_and_mcp_and_replays_after_restart";
const ARTIFACT_NAMES = Object.freeze([
  "canonical_request",
  "database_state",
  "diagnostics",
  "evidence_graph",
  "http_response",
  "mcp_response",
  "operation_response",
  "receipt_chain",
  "result",
  "telemetry",
]);

export function parseSherwoodProcessCapture(text) {
  let capture;
  try {
    capture = JSON.parse(text);
  } catch {
    throw new Error("The Sherwood process capture is not valid JSON.");
  }

  if (JSON.stringify(capture) !== text) {
    throw new Error("The Sherwood process capture is not canonical JSON.");
  }
  if (
    !isRecord(capture) ||
    capture.schema !== "sherwood.gossip-v2-process-capture.v1" ||
    capture.test !== PROCESS_TEST ||
    capture.operation_id !== "process-conformance" ||
    capture.redaction_profile !== "digests-and-counts-only"
  ) {
    throw new Error("The Sherwood process capture identity is invalid.");
  }

  const artifactNames = isRecord(capture.artifacts)
    ? Object.keys(capture.artifacts).sort()
    : [];
  if (JSON.stringify(artifactNames) !== JSON.stringify(ARTIFACT_NAMES)) {
    throw new Error("The Sherwood process capture artifact set is incomplete.");
  }
  for (const name of ARTIFACT_NAMES) {
    const artifact = capture.artifacts[name];
    if (
      !isRecord(artifact) ||
      Object.keys(artifact).sort().join(",") !== "byte_length,digest" ||
      !Number.isSafeInteger(artifact.byte_length) ||
      artifact.byte_length <= 0 ||
      !SHA256.test(artifact.digest)
    ) {
      throw new Error(
        `The Sherwood process capture ${name} fingerprint is invalid.`,
      );
    }
  }

  if (
    capture.artifacts.http_response.digest !==
      capture.artifacts.mcp_response.digest ||
    capture.artifacts.http_response.byte_length !==
      capture.artifacts.mcp_response.byte_length
  ) {
    throw new Error("The Sherwood HTTP and MCP captures are not equivalent.");
  }
  if (
    !isRecord(capture.privacy) ||
    capture.privacy.canary_present !== false ||
    capture.privacy.key_material_present !== false ||
    capture.privacy.raw_payloads_present !== false
  ) {
    throw new Error("The Sherwood process capture privacy result is invalid.");
  }
  if (
    !isRecord(capture.telemetry) ||
    capture.telemetry.enabled !== false ||
    capture.telemetry.captured_event_count !== 0 ||
    capture.telemetry.reason !== "disabled-by-conformance-profile"
  ) {
    throw new Error(
      "The Sherwood process capture telemetry result is invalid.",
    );
  }

  return capture;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
