"""Independently verify the frozen Gossip private-evidence policy vectors."""

import hashlib
import io
import json
import runpy
from contextlib import redirect_stdout
from pathlib import Path


ROOT = Path(__file__).parent.parent
PROTOCOL = "gossip/2-draft.1"
POLICY_SCHEMA = "gossip.privacy-policy.v1"
CONSENT_SCHEMA = "gossip.publication-consent.v1"
DELETION_RESULT_SCHEMA = "gossip.privacy-deletion-result.v1"
CORRECTION_RESULT_SCHEMA = "gossip.privacy-correction-result.v1"
DATA_CLASSES = {
    "private_payload",
    "public_envelope",
    "operation",
    "receipt",
    "quarantine_record",
    "access_audit",
    "aggregate_metric",
}
OWNER_OPERATIONS = {"export", "delete", "correct", "access_audit"}
EXPECTED_DATA_CLASSES = {
    "private_payload": {
        "retention_seconds": 2_592_000,
        "retention_clock": "stored_at",
        "export": "full",
        "deletion": "delete_payload_keep_tombstone",
        "hold": "defer_deletion",
        "immutable_history_exception": "none",
    },
    "public_envelope": {
        "retention_seconds": 31_557_600,
        "retention_clock": "published_at",
        "export": "metadata",
        "deletion": "retain_integrity_record",
        "hold": "not_applicable",
        "immutable_history_exception": "published_commitment",
    },
    "operation": {
        "retention_seconds": 31_557_600,
        "retention_clock": "accepted_at",
        "export": "metadata",
        "deletion": "retain_integrity_record",
        "hold": "not_applicable",
        "immutable_history_exception": "accepted_operation",
    },
    "receipt": {
        "retention_seconds": 31_557_600,
        "retention_clock": "issued_at",
        "export": "metadata",
        "deletion": "retain_integrity_record",
        "hold": "not_applicable",
        "immutable_history_exception": "signed_receipt",
    },
    "quarantine_record": {
        "retention_seconds": 604_800,
        "retention_clock": "quarantined_at",
        "export": "metadata",
        "deletion": "delete_at_retention",
        "hold": "defer_deletion",
        "immutable_history_exception": "none",
    },
    "access_audit": {
        "retention_seconds": 7_776_000,
        "retention_clock": "occurred_at",
        "export": "metadata",
        "deletion": "delete_at_retention",
        "hold": "defer_deletion",
        "immutable_history_exception": "none",
    },
    "aggregate_metric": {
        "retention_seconds": 2_592_000,
        "retention_clock": "window_end",
        "export": "none",
        "deletion": "aggregate_only",
        "hold": "not_applicable",
        "immutable_history_exception": "none",
    },
}
EXPECTED_OPERATION_OUTCOMES = {
    "export": ["exported", "unavailable"],
    "delete": [
        "deleted",
        "already_deleted",
        "held",
        "immutable",
        "unavailable",
    ],
    "correct": ["corrected", "already_corrected", "unavailable"],
    "access_audit": ["returned", "unavailable"],
}


def load_canonicalizer():
    namespace = runpy.run_path(str(Path(__file__).parent / "verify-v2-vectors.py"))
    return namespace["canonical_json"]


def load_eip191_verifier():
    with redirect_stdout(io.StringIO()):
        namespace = runpy.run_path(
            str(Path(__file__).parent / "verify-v2-http-auth.py")
        )
    return namespace["verify_signature"]


def identity_digest(value: object) -> str:
    payload = f"{PROTOCOL}\nidentity\n{canonical_json(value)}".encode("utf-8")
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def request_digest(value: object) -> str:
    payload = f"{PROTOCOL}\nrequest\n{canonical_json(value)}".encode("utf-8")
    return "sha256:" + hashlib.sha256(payload).hexdigest()


fixture = json.loads(
    (ROOT / "test" / "fixtures" / "v2-privacy.json").read_text(encoding="utf-8")
)
canonical_json = load_canonicalizer()
verify_signature = load_eip191_verifier()

policy = fixture["policy"]
assert policy["schema"] == POLICY_SCHEMA
assert policy["protocol"] == PROTOCOL
assert policy["activation"] == "blocked_pending_approval"
assert policy["product_approved"] is False
assert policy["raw_private_evidence"] == "offchain_encrypted_owner_scoped"
assert policy["public_commitment_default"] == "forbidden_without_consent"
assert {entry["name"] for entry in policy["data_classes"]} == DATA_CLASSES
assert len(policy["data_classes"]) == len(DATA_CLASSES)
for entry in policy["data_classes"]:
    name = entry["name"]
    assert {key: value for key, value in entry.items() if key != "name"} == (
        EXPECTED_DATA_CLASSES[name]
    )
assert {entry["action"] for entry in policy["owner_operations"]} == OWNER_OPERATIONS
assert len(policy["owner_operations"]) == len(OWNER_OPERATIONS)
assert all(entry["idempotent"] is True for entry in policy["owner_operations"])
assert all(
    entry["unavailable_error"] == "privacy_unavailable"
    for entry in policy["owner_operations"]
)
for entry in policy["owner_operations"]:
    assert entry["outcomes"] == EXPECTED_OPERATION_OUTCOMES[entry["action"]]

operation_vectors = fixture["operation_vectors"]
assert len(operation_vectors) == len(OWNER_OPERATIONS)
assert {
    json.loads(vector["canonical"])["action"]["kind"]
    for vector in operation_vectors
} == OWNER_OPERATIONS
for vector in operation_vectors:
    operation = json.loads(vector["canonical"])
    assert canonical_json(operation) == vector["canonical"]
    assert request_digest(operation) == vector["digest"]

result_vectors = fixture["result_vectors"]
assert len(result_vectors) == 5
assert {vector["kind"] for vector in result_vectors} == {"deletion", "correction"}
for vector in result_vectors:
    result = json.loads(vector["canonical"])
    assert canonical_json(result) == vector["canonical"]
    assert result["protocol"] == PROTOCOL
    assert result["policy_revision"] == policy["revision"]
    assert result["owner"] == {
        "address": "0x1111111111111111111111111111111111111111",
        "chain_id": "4663",
    }
    if vector["kind"] == "deletion":
        assert result["schema"] == DELETION_RESULT_SCHEMA
        assert result["outcome"] in {"deleted", "already_deleted", "held"}
        if result["outcome"] == "held":
            assert set(result) == {
                "schema",
                "protocol",
                "policy_revision",
                "owner",
                "operation_id",
                "outcome",
            }
        else:
            assert set(result) == {
                "schema",
                "protocol",
                "policy_revision",
                "owner",
                "operation_id",
                "outcome",
                "tombstone",
            }
            assert result["tombstone"]["schema"] == "gossip.privacy-tombstone.v1"
            assert result["tombstone"]["owner"] == result["owner"]
            assert result["tombstone"]["deletion_operation_id"] == result[
                "operation_id"
            ]
    else:
        assert vector["kind"] == "correction"
        assert result["schema"] == CORRECTION_RESULT_SCHEMA
        assert result["outcome"] in {"corrected", "already_corrected"}
        assert set(result) == {
            "schema",
            "protocol",
            "policy_revision",
            "owner",
            "operation_id",
            "outcome",
            "correction_digests",
        }
        assert len(result["correction_digests"]) > 0
        assert len(result["correction_digests"]) <= 64
        assert len(set(result["correction_digests"])) == len(
            result["correction_digests"]
        )

signed_consent = fixture["signed_consent"]
consent = signed_consent["consent"]
assert consent["schema"] == CONSENT_SCHEMA
assert consent["protocol"] == PROTOCOL
assert consent["policy_revision"] == policy["revision"]
assert 0 < consent["expires_at"] - consent["issued_at"] <= 3600
assert len(consent["disclosures"]) == len(set(consent["disclosures"]))
assert set(consent["disclosures"]).issubset({"public_commitment", "linkable_identity"})

consent_digest = identity_digest(consent)
assert consent_digest == signed_consent["consent_digest"]
consent_message = "\n".join(
    ["Gossip publication consent v1", PROTOCOL, CONSENT_SCHEMA, consent_digest]
)
assert consent_message == fixture["consent_message"]
verify_signature(
    signed_consent["root_public_key"],
    consent["owner"]["address"],
    consent_message.encode("utf-8"),
    signed_consent["signature"],
)

print("v2 private-evidence policy, operations, and signed consent verified")
