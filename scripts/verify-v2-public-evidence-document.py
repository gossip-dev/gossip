#!/usr/bin/env python3
"""Verify the public evidence document vector independently of TypeScript."""

import copy
import hashlib
import json
import re
from pathlib import Path
from typing import Any


PROTOCOL = "gossip/2-draft.1"
SCHEMA_REVISION = "2026-09-11"
EVIDENCE_SCHEMA_REVISION = "2026-09-09"
SCHEMA = "gossip.public-evidence-document.v1"
DIGEST_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")
RELATIONSHIPS = {"derived_from", "supersedes", "conflicts_with"}
MAX_LINKS = 256


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def digest(domain: str, value: Any) -> str:
    message = f"{PROTOCOL}\n{domain}\n{canonical_json(value)}".encode("utf-8")
    return "sha256:" + hashlib.sha256(message).hexdigest()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def exact_keys(value: Any, expected: set[str], message: str) -> None:
    require(isinstance(value, dict) and set(value) == expected, message)


def verify_evidence(value: Any) -> None:
    required = {
        "protocol",
        "schema_revision",
        "schema",
        "subject",
        "kind",
        "claim",
        "provenance",
        "observed_at",
        "validity",
        "sources",
        "verification",
        "confidence",
        "access",
        "derived_from",
        "supersedes",
        "correction_reason",
        "conflicts_with",
    }
    exact_keys(value, required, "evidence fields are not exact")
    require(
        value["protocol"] == PROTOCOL
        and value["schema_revision"] == EVIDENCE_SCHEMA_REVISION
        and value["schema"] == "gossip.evidence.v1",
        "evidence literals are invalid",
    )
    require(value["access"] == {"visibility": "public"}, "evidence is private")
    require(
        isinstance(value["sources"], list) and value["sources"], "sources are invalid"
    )
    for source in value["sources"]:
        exact_keys(
            source,
            {"source_id", "revision", "content_hash", "location"},
            "source is invalid",
        )
        location = source["location"]
        require(
            isinstance(location, dict)
            and set(location) == {"visibility", "uri"}
            and location["visibility"] == "public"
            and isinstance(location["uri"], str)
            and location["uri"].startswith("https://"),
            "source location is private or invalid",
        )

    for name in ("derived_from", "conflicts_with"):
        references = value[name]
        require(isinstance(references, list), f"{name} is invalid")
        require(
            all(
                isinstance(item, str) and DIGEST_PATTERN.fullmatch(item)
                for item in references
            ),
            f"{name} contains an invalid digest",
        )
    supersedes = value["supersedes"]
    if supersedes is not None:
        require(
            isinstance(supersedes, str) and DIGEST_PATTERN.fullmatch(supersedes),
            "supersedes contains an invalid digest",
        )
    require(
        (supersedes is None) == (value["correction_reason"] is None),
        "correction reason does not match supersedes",
    )
    if value["correction_reason"] is not None:
        require(
            isinstance(value["correction_reason"], str)
            and 0 < len(value["correction_reason"]) <= 256,
            "correction reason is invalid",
        )


def verify_document(document: dict[str, Any]) -> None:
    exact_keys(
        document,
        {"protocol", "schema_revision", "schema", "digest", "evidence", "links"},
        "document fields are not exact",
    )
    require(
        document["protocol"] == PROTOCOL
        and document["schema_revision"] == SCHEMA_REVISION
        and document["schema"] == SCHEMA,
        "document literals are invalid",
    )
    requested_digest = document["digest"]
    require(
        isinstance(requested_digest, str)
        and DIGEST_PATTERN.fullmatch(requested_digest),
        "requested digest is invalid",
    )
    verify_evidence(document["evidence"])
    require(
        digest("evidence", document["evidence"]) == requested_digest,
        "evidence digest mismatch",
    )

    links = document["links"]
    require(isinstance(links, list), "links are not an array")
    require(len(links) <= MAX_LINKS, "link limit exceeded")
    previous_key: tuple[str, str, str] | None = None
    seen: set[tuple[str, str, str]] = set()
    evidence_references = {
        "derived_from": set(document["evidence"]["derived_from"]),
        "supersedes": (
            set()
            if document["evidence"]["supersedes"] is None
            else {document["evidence"]["supersedes"]}
        ),
        "conflicts_with": set(document["evidence"]["conflicts_with"]),
    }
    outgoing_links: set[tuple[str, str, str]] = set()
    expected_outgoing_links = {
        (requested_digest, relationship, parent)
        for relationship, parents in evidence_references.items()
        for parent in parents
    }
    for link in links:
        exact_keys(
            link,
            {"child_digest", "relationship", "parent_digest", "correction_reason"},
            "link fields are not exact",
        )
        child = link["child_digest"]
        parent = link["parent_digest"]
        relationship = link["relationship"]
        require(
            isinstance(child, str)
            and DIGEST_PATTERN.fullmatch(child)
            and isinstance(parent, str)
            and DIGEST_PATTERN.fullmatch(parent)
            and relationship in RELATIONSHIPS,
            "link values are invalid",
        )
        require(child != parent, "self-link is invalid")
        key = (child, relationship, parent)
        require(
            key not in seen and (previous_key is None or key > previous_key),
            "link order is invalid",
        )
        seen.add(key)
        previous_key = key
        require(
            child == requested_digest or parent == requested_digest,
            "link does not mention requested digest",
        )
        if relationship == "supersedes":
            require(
                isinstance(link["correction_reason"], str)
                and 0 < len(link["correction_reason"]) <= 256,
                "supersedes correction reason is invalid",
            )
        else:
            require(
                link["correction_reason"] is None, "non-supersedes reason is invalid"
            )
        if child == requested_digest:
            outgoing_links.add(key)
            require(
                parent in evidence_references[relationship],
                "link is not in evidence payload",
            )
            if relationship == "supersedes":
                require(
                    link["correction_reason"]
                    == document["evidence"]["correction_reason"],
                    "supersedes reason does not match evidence",
                )
    require(
        outgoing_links == expected_outgoing_links,
        "outgoing links do not cover the evidence references exactly",
    )


def main() -> None:
    fixture_path = (
        Path(__file__).parents[1]
        / "test"
        / "fixtures"
        / "v2-public-evidence-document.json"
    )
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    document = fixture["valid"]
    verify_document(document)
    require(
        canonical_json(document) == canonical_json(fixture["valid"]), "fixture changed"
    )

    unknown = copy.deepcopy(document)
    unknown["transport"] = "http"
    try:
        verify_document(unknown)
    except AssertionError:
        pass
    else:
        raise AssertionError("unknown field was accepted")

    private = copy.deepcopy(document)
    private["evidence"]["access"] = {"visibility": "owner"}
    private["digest"] = digest("evidence", private["evidence"])
    try:
        verify_document(private)
    except AssertionError:
        pass
    else:
        raise AssertionError("private evidence was accepted")

    missing_link = copy.deepcopy(document)
    missing_link["evidence"]["conflicts_with"] = ["sha256:" + "d" * 64]
    missing_link["digest"] = digest("evidence", missing_link["evidence"])
    try:
        verify_document(missing_link)
    except AssertionError:
        pass
    else:
        raise AssertionError("missing outgoing link was accepted")

    print(
        "v2 public evidence document, public digest parity, and lineage links verified"
    )


if __name__ == "__main__":
    main()
