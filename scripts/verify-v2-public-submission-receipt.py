#!/usr/bin/env python3
"""Verify the public-submission receipt without importing the TypeScript code."""

import base64
import copy
import hashlib
import json
import re
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit


PROTOCOL = "gossip/2-draft.1"
SCHEMA_REVISION = "2026-09-11"
DIGEST_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")
IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$")
OPERATION_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
ADDRESS_PATTERN = re.compile(r"^0x[0-9a-f]{40}$")
UINT_PATTERN = re.compile(r"^(?:0|[1-9][0-9]*)$")
UINT256_MAX = (1 << 256) - 1


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def digest(domain: str, value: Any) -> str:
    message = f"{PROTOCOL}\n{domain}\n{canonical_json(value)}".encode("utf-8")
    return "sha256:" + hashlib.sha256(message).hexdigest()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def https_url(value: Any) -> None:
    require(
        isinstance(value, str)
        and 0 < len(value) <= 2048
        and "#" not in value
        and not re.search(r"[\s\x00-\x1f\x7f-\x9f]", value),
        "URL is not canonical HTTPS",
    )

    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as error:
        raise AssertionError("URL is not canonical HTTPS") from error

    require(
        parsed.scheme == "https"
        and parsed.netloc != ""
        and parsed.hostname is not None
        and parsed.username is None
        and parsed.password is None
        and parsed.fragment == ""
        and parsed.path != ""
        and parsed.geturl() == value
        and parsed.netloc == parsed.netloc.lower()
        and not parsed.netloc.endswith(":")
        and (port is None or parsed.netloc.endswith(f":{port}"))
        and port != 443,
        "URL is not canonical HTTPS",
    )
    require(
        all(
            segment.lower().replace("%2e", ".") not in {".", ".."}
            for segment in parsed.path.split("/")
        ),
        "URL is not canonical HTTPS",
    )


def verify_receipt(receipt: dict[str, Any]) -> str:
    required = {
        "protocol",
        "schema_revision",
        "schema",
        "auth_profile",
        "operation_kind",
        "operation_id",
        "request_digest",
        "actor",
        "owner",
        "endpoint",
        "audience",
        "server",
        "signing",
        "issued_at",
        "status",
        "max_cost",
        "economics",
        "result_digest",
        "evidence_digests",
    }
    require(set(receipt) == required, "receipt fields are not exact")
    require(
        receipt["protocol"] == PROTOCOL
        and receipt["schema_revision"] == SCHEMA_REVISION
        and receipt["schema"] == "gossip.public-submission-receipt.v1"
        and receipt["auth_profile"] == "gossip-eip191-v2"
        and receipt["operation_kind"] == "public_submission"
        and receipt["status"] == "complete",
        "receipt literals are invalid",
    )
    require(
        isinstance(receipt["operation_id"], str)
        and OPERATION_PATTERN.fullmatch(receipt["operation_id"]) is not None,
        "operation ID is invalid",
    )
    require(
        isinstance(receipt["request_digest"], str)
        and DIGEST_PATTERN.fullmatch(receipt["request_digest"]) is not None,
        "request digest is invalid",
    )

    for name in ("actor", "owner"):
        actor = receipt[name]
        require(
            isinstance(actor, dict)
            and set(actor) == {"chain_id", "address"}
            and isinstance(actor["chain_id"], str)
            and UINT_PATTERN.fullmatch(actor["chain_id"]) is not None
            and 0 < int(actor["chain_id"]) <= UINT256_MAX
            and isinstance(actor["address"], str)
            and ADDRESS_PATTERN.fullmatch(actor["address"]) is not None,
            f"{name} is invalid",
        )
    require(receipt["actor"] == receipt["owner"], "actor and owner differ")
    https_url(receipt["endpoint"])
    https_url(receipt["audience"])

    server = receipt["server"]
    require(
        isinstance(server, dict)
        and set(server) == {"id", "revision"}
        and IDENTIFIER_PATTERN.fullmatch(server["id"]) is not None
        and IDENTIFIER_PATTERN.fullmatch(server["revision"]) is not None,
        "server is invalid",
    )
    signing = receipt["signing"]
    require(
        isinstance(signing, dict)
        and set(signing) == {"profile", "key_id"}
        and signing["profile"] == "gossip-eip191-receipt-v1"
        and IDENTIFIER_PATTERN.fullmatch(signing["key_id"]) is not None,
        "signing is invalid",
    )
    require(
        isinstance(receipt["issued_at"], int)
        and 0 <= receipt["issued_at"] <= 253402300799,
        "issued_at is invalid",
    )
    require(
        receipt["max_cost"] == {"unit": "earned_credit", "amount": "0"},
        "maximum cost is not exactly zero",
    )
    require(
        receipt["economics"]
        == {
            "unit": "earned_credit",
            "state": "settled",
            "reserved_amount": "0",
            "charged_amount": "0",
        },
        "economics are not settled at zero",
    )
    require(
        isinstance(receipt["result_digest"], str)
        and DIGEST_PATTERN.fullmatch(receipt["result_digest"]) is not None,
        "result digest is invalid",
    )

    evidence_digests = receipt["evidence_digests"]
    require(
        isinstance(evidence_digests, list)
        and 0 < len(evidence_digests) <= 16
        and all(DIGEST_PATTERN.fullmatch(item) is not None for item in evidence_digests)
        and evidence_digests == sorted(set(evidence_digests)),
        "evidence digests are not canonical",
    )

    return digest("receipt", receipt)


def verify_envelope(envelope: dict[str, Any]) -> None:
    require(
        set(envelope) == {"receipt", "receipt_digest", "signature"},
        "envelope fields are not exact",
    )
    expected = verify_receipt(envelope["receipt"])
    require(envelope["receipt_digest"] == expected, "receipt digest mismatch")
    require(isinstance(envelope["signature"], str), "signature is not text")
    require(
        re.fullmatch(r"[A-Za-z0-9_-]+", envelope["signature"]) is not None,
        "signature encoding is invalid",
    )
    try:
        decoded = base64.urlsafe_b64decode(envelope["signature"] + "===")
    except ValueError as error:
        raise AssertionError("signature is not base64url") from error
    require(
        len(decoded) == 65 and decoded[64] in (27, 28), "signature shape is invalid"
    )
    require(
        base64.urlsafe_b64encode(decoded).decode("ascii").rstrip("=")
        == envelope["signature"],
        "signature is not canonical base64url",
    )


def verify_submission_binding(
    envelope: dict[str, Any], submission: dict[str, Any]
) -> None:
    receipt = envelope["receipt"]

    require(
        receipt["operation_id"] == submission["operation_id"],
        "operation ID is not bound to the submission",
    )
    require(
        receipt["request_digest"] == digest("request", submission),
        "request digest is not bound to the submission",
    )
    require(
        receipt["actor"] == submission["actor"]
        and receipt["owner"] == submission["actor"],
        "actor and owner are not bound to the submission",
    )
    require(
        receipt["endpoint"] == submission["endpoint"]
        and receipt["audience"] == submission["audience"],
        "destination is not bound to the submission",
    )
    require(
        receipt["result_digest"] == digest("evidence", submission["result"]),
        "result digest is not bound to the submission",
    )
    require(
        receipt["evidence_digests"] == submission["evidence"]["roots"],
        "evidence roots are not bound to the submission",
    )


def main() -> None:
    fixture_path = (
        Path(__file__).parents[1]
        / "test"
        / "fixtures"
        / "v2-public-submission-receipt.json"
    )
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    envelope = fixture["receipt"]
    verify_envelope(envelope)

    submission_path = fixture_path.with_name("v2-public-submission.json")
    submission = json.loads(submission_path.read_text(encoding="utf-8"))["valid"]
    verify_submission_binding(envelope, submission)

    tampered = copy.deepcopy(envelope)
    tampered["receipt"]["economics"]["charged_amount"] = "1"
    try:
        verify_envelope(tampered)
    except AssertionError:
        pass
    else:
        raise AssertionError("nonzero economics were accepted")

    invented = copy.deepcopy(envelope)
    invented["already_persisted"] = False
    try:
        verify_envelope(invented)
    except AssertionError:
        pass
    else:
        raise AssertionError("retry flag was accepted")

    different_submission = copy.deepcopy(submission)
    different_submission["operation_id"] = "different-public-submission"
    try:
        verify_submission_binding(envelope, different_submission)
    except AssertionError:
        pass
    else:
        raise AssertionError("receipt was accepted for a different submission")

    malformed_url = copy.deepcopy(envelope)
    malformed_url["receipt"]["endpoint"] = "https://gossip.example:bad/mcp"
    try:
        verify_envelope(malformed_url)
    except AssertionError:
        pass
    else:
        raise AssertionError("malformed receipt endpoint was accepted")

    print("public-submission receipt contract and receipt digest verified")


if __name__ == "__main__":
    main()
