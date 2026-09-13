#!/usr/bin/env python3
"""Verify the public-submission contract without importing the TypeScript code."""

import copy
import hashlib
import json
import re
from urllib.parse import urlsplit
from pathlib import Path
from typing import Any


PROTOCOL = "gossip/2-draft.1"
EVIDENCE_SCHEMA_REVISION = "2026-09-09"
PUBLIC_SUBMISSION_SCHEMA_REVISION = "2026-09-11"
DIGEST_PREFIX = "sha256:"
DIGEST_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")
ADDRESS_PATTERN = re.compile(r"^0x[0-9a-f]{40}$")
OPERATION_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
UINT_PATTERN = re.compile(r"^(?:0|[1-9][0-9]*)$")
UINT256_MAX = (1 << 256) - 1


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def digest(domain: str, value: Any) -> str:
    message = f"{PROTOCOL}\n{domain}\n{canonical_json(value)}".encode("utf-8")
    return DIGEST_PREFIX + hashlib.sha256(message).hexdigest()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def verify_https_url(value: Any, field: str) -> None:
    require(
        isinstance(value, str)
        and 0 < len(value) <= 2048
        and "#" not in value
        and not re.search(r"[\s\x00-\x1f\x7f-\x9f]", value),
        f"{field} is invalid",
    )

    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as error:
        raise AssertionError(f"{field} is invalid") from error

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
        f"{field} is invalid",
    )
    require(
        all(
            segment.lower().replace("%2e", ".") not in {".", ".."}
            for segment in parsed.path.split("/")
        ),
        f"{field} is invalid",
    )


def verify_submission(submission: dict[str, Any]) -> str:
    required = {
        "protocol",
        "schema_revision",
        "schema",
        "auth_profile",
        "operation_kind",
        "operation_id",
        "actor",
        "endpoint",
        "audience",
        "max_cost",
        "result",
        "evidence",
    }
    require(set(submission) == required, "submission fields are not exact")
    require(submission["protocol"] == PROTOCOL, "protocol mismatch")
    require(
        submission["schema_revision"] == PUBLIC_SUBMISSION_SCHEMA_REVISION,
        "revision mismatch",
    )
    require(submission["schema"] == "gossip.public-submission.v1", "schema mismatch")
    require(submission["auth_profile"] == "gossip-eip191-v2", "auth profile mismatch")
    require(submission["operation_kind"] == "public_submission", "kind mismatch")

    actor = submission["actor"]
    require(
        set(actor) == {"chain_id", "address"}
        and isinstance(actor["chain_id"], str)
        and UINT_PATTERN.fullmatch(actor["chain_id"]) is not None
        and 0 < int(actor["chain_id"]) <= UINT256_MAX
        and isinstance(actor["address"], str)
        and ADDRESS_PATTERN.fullmatch(actor["address"]) is not None,
        "actor is invalid",
    )
    require(
        isinstance(submission["operation_id"], str)
        and OPERATION_PATTERN.fullmatch(submission["operation_id"]) is not None,
        "operation ID is invalid",
    )
    verify_https_url(submission["endpoint"], "endpoint")
    verify_https_url(submission["audience"], "audience")
    require(
        submission["max_cost"] == {"unit": "earned_credit", "amount": "0"},
        "cost is not exactly zero earned_credit",
    )

    result = submission["result"]
    graph = submission["evidence"]
    require(
        result["protocol"] == PROTOCOL
        and result["schema_revision"] == EVIDENCE_SCHEMA_REVISION
        and result["schema"] == "gossip.result.v2",
        "result manifest is invalid",
    )
    require(set(graph) == {"roots", "bundles"}, "graph fields are not exact")
    require(result["evidence_digests"] == graph["roots"], "root mismatch")

    bundles = {bundle["digest"]: bundle for bundle in graph["bundles"]}
    require(len(bundles) == len(graph["bundles"]), "duplicate graph digest")
    require(
        all(root in bundles for root in graph["roots"]), "graph root is unavailable"
    )
    reachable: set[str] = set()

    def visit(reference: str) -> None:
        require(reference in bundles, "graph reference is unavailable")
        if reference in reachable:
            return
        reachable.add(reference)
        evidence = bundles[reference]["evidence"]
        for parent in evidence["derived_from"]:
            visit(parent)

    for root in graph["roots"]:
        visit(root)
    require(reachable == set(bundles), "graph contains unreachable evidence")

    for bundle in graph["bundles"]:
        evidence = bundle["evidence"]
        require(
            bundle["digest"] == digest("evidence", evidence), "evidence digest mismatch"
        )
        require(
            evidence["access"] == {"visibility": "public"},
            "private evidence is present",
        )
        for source in evidence["sources"]:
            require(
                source["location"]["visibility"] == "public",
                "private source is present",
            )
        for reference in evidence["derived_from"]:
            require(
                isinstance(reference, str)
                and DIGEST_PATTERN.fullmatch(reference) is not None,
                "derived reference is invalid",
            )
            require(reference in bundles, "graph reference is unavailable")
        for reference in evidence["conflicts_with"]:
            require(
                isinstance(reference, str)
                and DIGEST_PATTERN.fullmatch(reference) is not None,
                "conflict reference is invalid",
            )
            require(reference not in bundles, "conflict target must be external")
        if evidence["supersedes"] is not None:
            require(
                isinstance(evidence["supersedes"], str)
                and DIGEST_PATTERN.fullmatch(evidence["supersedes"]) is not None,
                "supersedes reference is invalid",
            )
            require(
                evidence["supersedes"] not in bundles,
                "superseded evidence must be external",
            )
        require(
            evidence["subject"] == result["subject"],
            "result and evidence subjects differ",
        )

    return digest("request", submission)


def submission_with_public_parent(
    submission: dict[str, Any],
    relation: str,
) -> dict[str, Any]:
    linked = copy.deepcopy(submission)
    root = linked["evidence"]["bundles"][0]
    parent_evidence = copy.deepcopy(root["evidence"])
    parent_digest = digest("evidence", parent_evidence)

    root["evidence"][relation] = [parent_digest]
    root["digest"] = digest("evidence", root["evidence"])
    linked["evidence"]["bundles"].append(
        {"digest": parent_digest, "evidence": parent_evidence}
    )
    linked["evidence"]["roots"] = [root["digest"]]
    linked["result"]["evidence_digests"] = [root["digest"]]
    return linked


def submission_with_external_lineage(
    submission: dict[str, Any], relation: str
) -> dict[str, Any]:
    linked = copy.deepcopy(submission)
    root = linked["evidence"]["bundles"][0]
    external_digest = "sha256:" + "d" * 64
    if relation == "supersedes":
        root["evidence"]["supersedes"] = external_digest
        root["evidence"]["correction_reason"] = "Corrects a prior public observation."
    else:
        root["evidence"]["conflicts_with"] = [external_digest]
    root["digest"] = digest("evidence", root["evidence"])
    linked["evidence"]["roots"] = [root["digest"]]
    linked["result"]["evidence_digests"] = [root["digest"]]
    return linked


def main() -> None:
    fixture_path = (
        Path(__file__).parents[1] / "test" / "fixtures" / "v2-public-submission.json"
    )
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    submission = fixture["valid"]
    require(
        canonical_json(submission) == fixture["canonical"], "canonical vector mismatch"
    )
    require(
        verify_submission(submission) == fixture["digest"], "request digest mismatch"
    )

    private_node = copy.deepcopy(submission)
    private_node["evidence"]["bundles"][0]["evidence"]["access"] = {
        "visibility": "owner",
        "owner": submission["actor"],
        "policy_revision": "synthetic",
    }
    private_node["evidence"]["bundles"][0]["digest"] = digest(
        "evidence", private_node["evidence"]["bundles"][0]["evidence"]
    )
    private_node["evidence"]["roots"] = [
        private_node["evidence"]["bundles"][0]["digest"]
    ]
    private_node["result"]["evidence_digests"] = private_node["evidence"]["roots"]
    try:
        verify_submission(private_node)
    except AssertionError:
        pass
    else:
        raise AssertionError("private node was accepted")

    root_mismatch = copy.deepcopy(submission)
    root_mismatch["result"]["evidence_digests"] = ["sha256:" + "a" * 64]
    try:
        verify_submission(root_mismatch)
    except AssertionError:
        pass
    else:
        raise AssertionError("root mismatch was accepted")

    public_lineage = submission_with_public_parent(submission, "derived_from")
    verify_submission(public_lineage)

    verify_submission(submission_with_external_lineage(submission, "supersedes"))
    verify_submission(submission_with_external_lineage(submission, "conflicts_with"))

    malformed_lineage = submission_with_external_lineage(submission, "conflicts_with")
    malformed_evidence = malformed_lineage["evidence"]["bundles"][0]["evidence"]
    malformed_evidence["conflicts_with"] = ["not-a-digest"]
    malformed_lineage["evidence"]["bundles"][0]["digest"] = digest(
        "evidence", malformed_evidence
    )
    malformed_lineage["evidence"]["roots"] = [
        malformed_lineage["evidence"]["bundles"][0]["digest"]
    ]
    malformed_lineage["result"]["evidence_digests"] = malformed_lineage["evidence"][
        "roots"
    ]
    try:
        verify_submission(malformed_lineage)
    except AssertionError:
        pass
    else:
        raise AssertionError("malformed external lineage was accepted")

    malformed_url = copy.deepcopy(submission)
    malformed_url["endpoint"] = "https://gossip.example:bad/mcp"
    try:
        verify_submission(malformed_url)
    except AssertionError:
        pass
    else:
        raise AssertionError("malformed endpoint was accepted")

    bundled_conflict = submission_with_public_parent(
        submission,
        "conflicts_with",
    )
    try:
        verify_submission(bundled_conflict)
    except AssertionError:
        pass
    else:
        raise AssertionError("bundled conflict target was accepted")

    require(
        fixture["canonical"] != fixture["canonical"] + " ",
        "canonical tampering vector is not distinct",
    )
    print("v2 public-submission contract, public closure, and request digest verified")


if __name__ == "__main__":
    main()
