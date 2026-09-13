const messages = Object.freeze({
  invalid_request: "The request does not match the protocol schema.",
  invalid_canonical_json: "The value is not valid canonical protocol JSON.",
  limit_exceeded: "A protocol resource limit was exceeded.",
  unsupported_version: "The protocol or schema revision is unsupported.",
  unsupported_auth_profile: "The exact authentication profile is unsupported.",
  unsupported_capability: "A required protocol capability is unavailable.",
  expired_deadline: "The consultation deadline has expired.",
  capability_mismatch:
    "The capability report does not match the configured connection.",
  expired_capabilities:
    "The capability report is outside its validity interval.",
  unauthorized: "The requested authority is unavailable.",
  operation_conflict: "The operation ID is already bound to different content.",
  operation_not_found: "The operation is unavailable to this identity.",
  reconciliation_required: "Authoritative reconciliation is required.",
  unsupported_tier: "The requested quality tier is unavailable.",
  maximum_cost_exceeded: "The selected work would exceed the maximum cost.",
  insufficient_credit: "The requested reservation is unavailable.",
  freshness_unmet: "The source facts do not meet the requested freshness.",
  finality_unmet: "The source facts do not meet the requested finality.",
  evidence_unavailable: "The requested evidence is unavailable.",
  invalid_evidence: "The evidence does not match the protocol contract.",
  invalid_receipt: "The receipt does not match the protocol contract.",
  digest_mismatch: "The supplied content digest does not match the content.",
  invalid_lineage: "The evidence lineage is invalid.",
  invalid_privacy_contract:
    "The privacy value does not match the protocol contract.",
  privacy_consent_required:
    "Fresh explicit consent is required for the requested disclosure.",
  privacy_unavailable: "The requested private resource is unavailable.",
  unsafe_telemetry:
    "The telemetry event contains an unsupported field or value.",
  invalid_conformance_manifest:
    "The conformance manifest does not match the protocol contract.",
  unsafe_conformance_artifact:
    "The conformance artifact contains prohibited diagnostic content.",
  operation_failed: "The accepted operation failed.",
});

export type ProtocolErrorCode = keyof typeof messages;

export class ProtocolError extends Error {
  constructor(readonly code: ProtocolErrorCode) {
    super(messages[code]);
    this.name = "ProtocolError";
  }
}
