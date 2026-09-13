#!/usr/bin/env python3
"""Build and independently verify Gossip v2 evidence and receipt vectors."""

from __future__ import annotations

import argparse
import base64
import copy
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any


PROTOCOL = "gossip/2-draft.1"
SCHEMA_REVISION = "2026-09-09"
DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
HASH = re.compile(r"^0x[0-9a-f]{64}$")
DECIMAL = re.compile(r"^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$")
MAX_TIME = 253_402_300_799


class VectorError(ValueError):
    """A vector violates the frozen evidence or receipt contract."""


def canonical_json(value: Any) -> str:
    """Encode the narrowed JSON profile with UTF-16 member ordering."""

    def key(value: str) -> bytes:
        return value.encode("utf-16-be")

    def encode(value: Any, depth: int = 0, nodes: list[int] | None = None) -> str:
        if nodes is None:
            nodes = [0]
        nodes[0] += 1
        if nodes[0] > 4_096 or depth > 16:
            raise VectorError("canonical tree limit")
        if value is None:
            return "null"
        if isinstance(value, bool):
            return "true" if value else "false"
        if isinstance(value, int) and not isinstance(value, bool):
            if abs(value) > 2**53 - 1:
                raise VectorError("unsafe integer")
            return str(value)
        if isinstance(value, float):
            raise VectorError("floats are forbidden")
        if isinstance(value, str):
            encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
        elif isinstance(value, list):
            if len(value) > 256:
                raise VectorError("array limit")
            encoded = (
                "[" + ",".join(encode(child, depth + 1, nodes) for child in value) + "]"
            )
        elif isinstance(value, dict):
            if len(value) > 64 or any(not isinstance(member, str) for member in value):
                raise VectorError("object limit")
            members = []
            for member in sorted(value, key=key):
                encoded_member = json.dumps(
                    member, ensure_ascii=False, separators=(",", ":")
                )
                members.append(
                    f"{encoded_member}:{encode(value[member], depth + 1, nodes)}"
                )
            encoded = "{" + ",".join(members) + "}"
        else:
            raise VectorError("unsupported JSON value")
        if len(encoded.encode("utf-8")) > 65_536:
            raise VectorError("byte limit")
        return encoded

    return encode(value)


def digest(domain: str, value: Any) -> str:
    payload = f"{PROTOCOL}\n{domain}\n{canonical_json(value)}".encode()
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def source(
    source_id: str, revision: str = "rev-1", owner: bool = False
) -> dict[str, Any]:
    location = (
        {"visibility": "owner", "reference": "source-local-1"}
        if owner
        else {"visibility": "public", "uri": "https://evidence.test/source.json"}
    )
    return {
        "source_id": source_id,
        "revision": revision,
        "content_hash": "sha256:" + "a" * 64,
        "location": location,
    }


def evidence(
    *,
    kind: str,
    predicate: str,
    value: dict[str, Any],
    validity: dict[str, Any],
    provenance: str,
    observed_at: int,
    sources: list[dict[str, Any]],
    limitations: list[str] | None = None,
    derived_from: list[str] | None = None,
    supersedes: str | None = None,
    conflicts_with: list[str] | None = None,
    owner: bool = False,
) -> dict[str, Any]:
    actor = {"chain_id": "4663", "address": "0x" + "1" * 40}
    return {
        "protocol": PROTOCOL,
        "schema_revision": SCHEMA_REVISION,
        "schema": "gossip.evidence.v1",
        "subject": {
            "kind": "token",
            "chain_id": "4663",
            "address": "0x" + "2" * 40,
        },
        "kind": kind,
        "claim": {
            "predicate": predicate,
            "value": value,
            "limitations": limitations or [],
        },
        "provenance": provenance,
        "observed_at": observed_at,
        "validity": validity,
        "sources": sources,
        "verification": {
            "mode": "replay",
            "method": "sha256-json",
            "revision": "v1",
            "source_ids": [item["source_id"] for item in sources],
            "instructions": "Hash the exact immutable source bytes and compare the declared fields.",
        },
        "confidence": [
            {
                "component": "reproducibility",
                "assessment": "supported",
                "explanation": "The immutable source revision is declared.",
            }
        ],
        "access": (
            {"visibility": "owner", "owner": actor, "policy_revision": "private-v1"}
            if owner
            else {"visibility": "public"}
        ),
        "derived_from": derived_from or [],
        "supersedes": supersedes,
        "correction_reason": (
            "Corrected immutable source revision." if supersedes else None
        ),
        "conflicts_with": conflicts_with or [],
    }


def envelope(payload: dict[str, Any]) -> dict[str, Any]:
    return {"digest": digest("evidence", payload), "evidence": payload}


def consultation() -> dict[str, Any]:
    return {
        "protocol": PROTOCOL,
        "schema_revision": SCHEMA_REVISION,
        "auth_profile": "gossip-eip191-v2",
        "operation_id": "vector-operation-1",
        "actor": {"chain_id": "4663", "address": "0x" + "1" * 40},
        "subject": {"kind": "token", "chain_id": "4663", "address": "0x" + "2" * 40},
        "capability": "token_overview",
        "endpoint": "https://engine.test/mcp",
        "audience": "https://engine.test/",
        "quality": {
            "tier": "enriched",
            "max_age_seconds": 3_600,
            "finality": "safe",
            "allow_partial": True,
        },
        "max_cost": {"unit": "earned_credit", "amount": "10"},
        "deadline": 1_900_000_000,
    }


def receipt(
    request: dict[str, Any],
    *,
    kind: str,
    sequence: int,
    previous: str | None,
    status: str,
    economics_state: str,
    charged: str | None,
    result: str | None,
    error: str | None,
    unmet: list[str] | None = None,
) -> dict[str, Any]:
    payload = {
        "protocol": PROTOCOL,
        "schema_revision": SCHEMA_REVISION,
        "schema": "gossip.receipt.v2",
        "auth_profile": "gossip-eip191-v2",
        "kind": kind,
        "operation_id": request["operation_id"],
        "request_digest": digest("request", request),
        "actor": request["actor"],
        "owner": request["actor"],
        "endpoint": request["endpoint"],
        "audience": request["audience"],
        "server": {"id": "sherwood", "revision": "synthetic-v1"},
        "signing": {"profile": "synthetic-unverified", "key_id": "test-key-1"},
        "sequence": sequence,
        "previous_receipt_digest": previous,
        "accepted_at": 1_800_000_000,
        "issued_at": 1_800_000_000 + sequence,
        "status": status,
        "quality": {
            "requested": request["quality"],
            "selected_tier": request["quality"]["tier"],
            "unmet_requirements": unmet or [],
        },
        "max_cost": request["max_cost"],
        "economics": {
            "unit": "earned_credit",
            "state": economics_state,
            "reserved_amount": "10",
            "charged_amount": charged,
        },
        "result_digest": result,
        "error_code": error,
    }
    receipt_digest = digest("receipt", payload)
    signature = (
        base64.urlsafe_b64encode(b"synthetic-not-authenticated").decode().rstrip("=")
    )
    return {
        "receipt": payload,
        "receipt_digest": receipt_digest,
        "signature": signature,
    }


def build_vectors() -> dict[str, Any]:
    chain_validity = {
        "type": "chain",
        "chain_id": "4663",
        "block_number": "42",
        "block_hash": "0x" + "b" * 64,
        "block_timestamp": 1_700_000_000,
        "transaction_hash": "0x" + "c" * 64,
        "log_index": "3",
        "finality": "safe",
        "canonicality": "canonical",
        "window": {"start": 1_699_999_990, "end": 1_700_000_000},
        "expires_at": 1_700_007_200,
    }
    source_validity = {
        "type": "source",
        "window": {"start": 1_700_000_000, "end": 1_700_000_100},
        "expires_at": 1_700_007_200,
        "basis": {
            "type": "issuer_interval",
            "valid_from": 1_699_999_000,
            "valid_until": 1_700_010_000,
        },
    }

    conflicting = envelope(
        evidence(
            kind="source_observation",
            predicate="transfer-observed",
            value={"state": "known", "type": "boolean", "value": False},
            validity=source_validity,
            provenance="observed",
            observed_at=1_700_000_200,
            sources=[source("conflicting-snapshot")],
            limitations=["This immutable source conflicts with the chain observation."],
        )
    )
    chain = envelope(
        evidence(
            kind="chain_observation",
            predicate="transfer-observed",
            value={"state": "known", "type": "boolean", "value": True},
            validity=chain_validity,
            provenance="observed",
            observed_at=1_700_000_010,
            sources=[source("rpc-log")],
            conflicts_with=[conflicting["digest"]],
        )
    )
    unknown = envelope(
        evidence(
            kind="source_observation",
            predicate="holder-count",
            value={"state": "unknown", "reason": "not_measured"},
            validity=source_validity,
            provenance="relayed",
            observed_at=1_700_000_200,
            sources=[source("indexer-snapshot")],
        )
    )
    parents = sorted([chain["digest"], unknown["digest"]])
    research = envelope(
        evidence(
            kind="research_heuristic",
            predicate="smart-money-signal",
            value={
                "state": "known",
                "type": "decimal",
                "value": "0.75",
                "unit": "ratio",
            },
            validity=source_validity,
            provenance="inferred",
            observed_at=1_700_000_200,
            sources=[source("heuristic-rules", "rules-v3")],
            limitations=[
                "Research heuristic only; it is not predictive or a profit claim."
            ],
            derived_from=parents,
        )
    )
    correction = envelope(
        evidence(
            kind="source_observation",
            predicate="holder-count",
            value={
                "state": "known",
                "type": "decimal",
                "value": "12",
                "unit": "wallets",
            },
            validity=source_validity,
            provenance="observed",
            observed_at=1_700_000_201,
            sources=[source("indexer-snapshot", "rev-2")],
            supersedes=unknown["digest"],
        )
    )
    owner_parent = envelope(
        evidence(
            kind="source_observation",
            predicate="private-note",
            value={
                "state": "known",
                "type": "text",
                "value": "Synthetic owner-only evidence.",
            },
            validity=source_validity,
            provenance="observed",
            observed_at=1_700_000_200,
            sources=[source("owner-note", owner=True)],
            owner=True,
        )
    )
    owner_child = envelope(
        evidence(
            kind="research_heuristic",
            predicate="private-analysis",
            value={"state": "known", "type": "boolean", "value": False},
            validity=source_validity,
            provenance="inferred",
            observed_at=1_700_000_200,
            sources=[source("owner-analysis", owner=True)],
            limitations=["Synthetic private example."],
            derived_from=[owner_parent["digest"]],
            owner=True,
        )
    )

    public_bundles = sorted(
        [chain, conflicting, unknown, research, correction],
        key=lambda item: item["digest"],
    )
    public_roots = sorted([research["digest"], correction["digest"]])
    public_graph = {"roots": public_roots, "bundles": public_bundles}
    owner_graph = {
        "roots": [owner_child["digest"]],
        "bundles": sorted([owner_parent, owner_child], key=lambda item: item["digest"]),
    }
    manifest = {
        "protocol": PROTOCOL,
        "schema_revision": SCHEMA_REVISION,
        "schema": "gossip.result.v2",
        "subject": chain["evidence"]["subject"],
        "evidence_digests": public_roots,
    }
    result_digest = digest("evidence", manifest)

    request = consultation()
    acknowledgment = receipt(
        request,
        kind="acknowledgment",
        sequence=0,
        previous=None,
        status="pending",
        economics_state="reserved",
        charged=None,
        result=None,
        error=None,
    )
    pending = receipt(
        request,
        kind="state",
        sequence=1,
        previous=acknowledgment["receipt_digest"],
        status="pending",
        economics_state="reserved",
        charged=None,
        result=None,
        error=None,
    )
    complete = receipt(
        request,
        kind="state",
        sequence=2,
        previous=pending["receipt_digest"],
        status="complete",
        economics_state="settled",
        charged="8",
        result=result_digest,
        error=None,
    )
    partial = receipt(
        request,
        kind="state",
        sequence=2,
        previous=pending["receipt_digest"],
        status="partial",
        economics_state="settled",
        charged="5",
        result=result_digest,
        error=None,
        unmet=["freshness"],
    )
    rejected = receipt(
        request,
        kind="state",
        sequence=2,
        previous=pending["receipt_digest"],
        status="rejected",
        economics_state="released",
        charged="0",
        result=None,
        error="evidence_unavailable",
    )
    reconciliation = receipt(
        request,
        kind="state",
        sequence=2,
        previous=pending["receipt_digest"],
        status="reconciliation_required",
        economics_state="unknown",
        charged=None,
        result=None,
        error="reconciliation_required",
    )

    objects = {
        "chainEvidence": chain,
        "conflictingEvidence": conflicting,
        "sourceUnknownEvidence": unknown,
        "researchEvidence": research,
        "correctionEvidence": correction,
        "publicGraph": public_graph,
        "ownerGraph": owner_graph,
        "resultManifest": manifest,
        "consultation": request,
        "acknowledgment": acknowledgment,
        "pendingReceipt": pending,
        "completeReceipt": complete,
        "partialReceipt": partial,
        "rejectedReceipt": rejected,
        "reconciliationReceipt": reconciliation,
    }
    literal_targets: dict[str, tuple[str, Any]] = {
        "chainEvidence": ("evidence", chain["evidence"]),
        "conflictingEvidence": ("evidence", conflicting["evidence"]),
        "sourceUnknownEvidence": ("evidence", unknown["evidence"]),
        "researchEvidence": ("evidence", research["evidence"]),
        "correctionEvidence": ("evidence", correction["evidence"]),
        "ownerEvidence": ("evidence", owner_child["evidence"]),
        "resultManifest": ("evidence", manifest),
        "acknowledgment": ("receipt", acknowledgment["receipt"]),
        "pendingReceipt": ("receipt", pending["receipt"]),
        "completeReceipt": ("receipt", complete["receipt"]),
        "partialReceipt": ("receipt", partial["receipt"]),
        "rejectedReceipt": ("receipt", rejected["receipt"]),
        "reconciliationReceipt": ("receipt", reconciliation["receipt"]),
    }
    literals = {
        name: {
            "domain": domain,
            "value": value,
            "canonical": canonical_json(value),
            "digest": digest(domain, value),
        }
        for name, (domain, value) in literal_targets.items()
    }
    graphs = {
        "public": {"value": public_graph, "canonical": canonical_json(public_graph)},
        "owner": {"value": owner_graph, "canonical": canonical_json(owner_graph)},
    }
    return {
        "protocol": PROTOCOL,
        "objects": objects,
        "literals": literals,
        "graphs": graphs,
    }


def require(condition: bool, message: str) -> None:
    if not condition:
        raise VectorError(message)


def verify_decimal(value: str) -> None:
    require(DECIMAL.fullmatch(value) is not None, "noncanonical decimal")
    unsigned = value.removeprefix("-")
    integer, separator, fraction = unsigned.partition(".")
    require(value != "-0", "negative zero")
    require(
        not (value.startswith("-") and set(unsigned.replace(".", "")) == {"0"}),
        "negative zero",
    )
    require(len(integer) + len(fraction) <= 78, "decimal digit limit")
    require(not separator or len(fraction) <= 18, "decimal fraction limit")


def verify_evidence(bundle: dict[str, Any]) -> None:
    item = bundle["evidence"]
    require(bundle["digest"] == digest("evidence", item), "evidence digest mismatch")
    require(DIGEST.fullmatch(bundle["digest"]) is not None, "invalid evidence digest")
    require(
        item["protocol"] == PROTOCOL and item["schema_revision"] == SCHEMA_REVISION,
        "wrong pins",
    )
    require(item["observed_at"] <= MAX_TIME, "invalid observed time")
    require(len(item["claim"]["limitations"]) <= 8, "too many limitations")
    require(
        len({entry["source_id"] for entry in item["sources"]}) == len(item["sources"]),
        "duplicate source",
    )
    value = item["claim"]["value"]
    if value["state"] == "known" and value["type"] == "decimal":
        verify_decimal(value["value"])
    validity = item["validity"]
    require(
        validity["window"]["start"] <= validity["window"]["end"] <= item["observed_at"],
        "invalid window",
    )
    if validity["type"] == "chain":
        require(validity["chain_id"] == item["subject"]["chain_id"], "wrong chain")
        require(
            validity["window"]["end"] == validity["block_timestamp"], "wrong block time"
        )
        require(
            HASH.fullmatch(validity["block_hash"]) is not None, "invalid block hash"
        )
        require(
            validity["transaction_hash"] is not None or validity["log_index"] is None,
            "log without transaction",
        )
    if any(
        source_ref["location"]["visibility"] == "owner"
        for source_ref in item["sources"]
    ):
        require(
            item["access"]["visibility"] == "owner",
            "owner source requires owner evidence",
        )
    if item["kind"] == "research_heuristic":
        require(item["provenance"] == "inferred", "heuristic provenance")
        require(
            bool(item["derived_from"]) and bool(item["claim"]["limitations"]),
            "heuristic context",
        )
    require(
        (item["supersedes"] is None) == (item["correction_reason"] is None),
        "correction reason",
    )


def verify_graph(graph: dict[str, Any]) -> None:
    canonical_json(graph)
    require(1 <= len(graph["roots"]) <= 16, "root limit")
    require(1 <= len(graph["bundles"]) <= 64, "bundle limit")
    require(graph["roots"] == sorted(set(graph["roots"])), "unsorted roots")
    by_digest = {bundle["digest"]: bundle for bundle in graph["bundles"]}
    require(len(by_digest) == len(graph["bundles"]), "duplicate bundles")
    reachable: set[str] = set()

    def visit_closure(label: str, public_parent: bool | None = None) -> None:
        require(label in by_digest, "missing reference")
        bundle = by_digest[label]
        current_public = bundle["evidence"]["access"]["visibility"] == "public"
        if public_parent:
            require(current_public, "public evidence references owner evidence")
        if label in reachable:
            return
        reachable.add(label)
        evidence_value = bundle["evidence"]
        parents = list(evidence_value["derived_from"])
        if evidence_value["supersedes"] is not None:
            parents.append(evidence_value["supersedes"])
        links = parents + list(evidence_value["conflicts_with"])
        for linked in links:
            require(linked != label, "self reference")
            visit_closure(linked, current_public)

    active: set[str] = set()
    greatest_depth: dict[str, int] = {}

    def visit_dag(label: str, depth: int) -> None:
        require(depth <= 16, "lineage depth")
        if label in active:
            raise VectorError("lineage cycle")
        previous_depth = greatest_depth.get(label)
        if previous_depth is not None and previous_depth >= depth:
            return
        active.add(label)
        evidence_value = by_digest[label]["evidence"]
        parents = list(evidence_value["derived_from"])
        if evidence_value["supersedes"] is not None:
            parents.append(evidence_value["supersedes"])
        for parent in parents:
            visit_dag(parent, depth + 1)
        active.remove(label)
        greatest_depth[label] = depth

    for root in graph["roots"]:
        visit_closure(root)
        visit_dag(root, 0)
    require(reachable == set(by_digest), "unreachable bundle")
    for label in reachable:
        visit_dag(label, 0)
    references = 0
    for bundle in graph["bundles"]:
        verify_evidence(bundle)
        item = bundle["evidence"]
        links = list(item["derived_from"]) + list(item["conflicts_with"])
        if item["supersedes"] is not None:
            links.append(item["supersedes"])
            previous = by_digest[item["supersedes"]]["evidence"]
            require(previous["subject"] == item["subject"], "supersession subject")
            require(previous["access"] == item["access"], "supersession access")
        references += len(links)
        require(references <= 128, "reference limit")

        source_access = item["access"]
        for linked_digest in links:
            target_access = by_digest[linked_digest]["evidence"]["access"]
            if source_access["visibility"] == "public":
                require(
                    target_access["visibility"] == "public", "public to owner reference"
                )
            elif target_access["visibility"] == "owner":
                require(
                    source_access["owner"] == target_access["owner"],
                    "different private owners",
                )


def verify_receipt(envelope_value: dict[str, Any], request: dict[str, Any]) -> None:
    item = envelope_value["receipt"]
    require(
        envelope_value["receipt_digest"] == digest("receipt", item),
        "receipt digest mismatch",
    )
    require(item["request_digest"] == digest("request", request), "request binding")
    for field in (
        "operation_id",
        "actor",
        "endpoint",
        "audience",
        "quality",
        "max_cost",
    ):
        expected = (
            request[field] if field not in {"quality", "max_cost"} else request[field]
        )
        actual = (
            item[field] if field not in {"quality"} else item["quality"]["requested"]
        )
        require(actual == expected, f"receipt binding: {field}")
    require(item["actor"] == item["owner"], "delegated owner is unsupported")
    require(
        item["accepted_at"] < request["deadline"]
        and item["accepted_at"] <= item["issued_at"],
        "receipt time",
    )
    require(
        int(item["economics"]["reserved_amount"]) <= int(item["max_cost"]["amount"]),
        "reservation exceeds ceiling",
    )
    charged = item["economics"]["charged_amount"]
    require(
        charged is None or int(charged) <= int(item["economics"]["reserved_amount"]),
        "charge exceeds reservation",
    )
    unmet = item["quality"]["unmet_requirements"]
    require(
        len(unmet) <= 3 and len(unmet) == len(set(unmet)), "invalid unmet requirements"
    )
    require(
        set(unmet) <= {"freshness", "finality", "evidence"}, "unknown unmet requirement"
    )
    if item["kind"] == "acknowledgment":
        require(
            item["sequence"] == 0 and item["previous_receipt_digest"] is None,
            "acknowledgment position",
        )
        require(
            item["status"] == "pending" and item["economics"]["state"] == "reserved",
            "acknowledgment state",
        )
        require(
            charged is None
            and item["result_digest"] is None
            and item["error_code"] is None
            and not unmet,
            "acknowledgment values",
        )
    else:
        require(
            item["sequence"] > 0 and item["previous_receipt_digest"] is not None,
            "state position",
        )
    if item["status"] == "pending":
        require(item["economics"]["state"] == "reserved", "pending economics")
        require(
            charged is None
            and item["result_digest"] is None
            and item["error_code"] is None
            and not unmet,
            "pending values",
        )
    elif item["status"] == "reconciliation_required":
        require(item["economics"]["state"] == "unknown", "reconciliation economics")
        require(
            charged is None and item["result_digest"] is None, "unknown is not zero"
        )
        require(item["error_code"] == "reconciliation_required", "reconciliation error")
    elif item["status"] == "complete":
        require(
            item["economics"]["state"] == "settled" and charged is not None,
            "complete economics",
        )
        require(
            item["result_digest"] is not None
            and item["error_code"] is None
            and not unmet,
            "complete values",
        )
    elif item["status"] == "partial":
        require(
            item["economics"]["state"] == "settled" and charged is not None,
            "partial economics",
        )
        require(
            request["quality"]["allow_partial"] and item["result_digest"] is not None,
            "partial result",
        )
        require(item["error_code"] is None and bool(unmet), "partial requirements")
    elif item["status"] == "rejected":
        require(
            item["economics"]["state"] == "released" and charged == "0",
            "rejected economics",
        )
        require(item["result_digest"] is None and not unmet, "rejected result")
        require(
            item["error_code"]
            in {
                "unauthorized",
                "freshness_unmet",
                "finality_unmet",
                "evidence_unavailable",
                "operation_failed",
            },
            "rejected error",
        )
    else:
        raise VectorError("unknown receipt status")
    signature = envelope_value["signature"]
    require("=" not in signature and 0 < len(signature) <= 1_024, "signature encoding")
    decoded = base64.urlsafe_b64decode(signature + "=" * (-len(signature) % 4))
    require(
        base64.urlsafe_b64encode(decoded).decode().rstrip("=") == signature,
        "noncanonical signature",
    )


def expect_rejected(action: Any, message: str) -> None:
    try:
        action()
    except (KeyError, TypeError, VectorError, ValueError):
        return
    raise VectorError(f"invalid vector accepted: {message}")


def verify_invalid_cases(objects: dict[str, Any]) -> None:
    verify_decimal("-0.5")
    for invalid_decimal in ("1" * 79, "0." + "1" * 19, "1.2.3", "-0"):
        expect_rejected(
            lambda candidate=invalid_decimal: verify_decimal(candidate),
            f"invalid decimal {invalid_decimal}",
        )

    bad_evidence = copy.deepcopy(objects["chainEvidence"])
    bad_evidence["evidence"]["validity"]["window"]["end"] += 1
    expect_rejected(lambda: verify_evidence(bad_evidence), "tampered chain anchor")

    bad_digest = copy.deepcopy(objects["chainEvidence"])
    bad_digest["digest"] = "sha256:" + "0" * 64
    expect_rejected(lambda: verify_evidence(bad_digest), "evidence digest")

    missing_parent = copy.deepcopy(objects["publicGraph"])
    missing_parent["bundles"] = [
        bundle
        for bundle in missing_parent["bundles"]
        if bundle["digest"] != objects["sourceUnknownEvidence"]["digest"]
    ]
    expect_rejected(lambda: verify_graph(missing_parent), "missing lineage parent")

    oversized_graph = copy.deepcopy(objects["publicGraph"])
    oversized_graph["bundles"] = oversized_graph["bundles"] * 20
    expect_rejected(lambda: verify_graph(oversized_graph), "graph byte limit")

    conflict_depth_graph = copy.deepcopy(objects["publicGraph"])
    conflict_root = conflict_depth_graph["bundles"][0]
    conflict_chain: list[dict[str, Any]] = []
    for index in range(18):
        bundle = copy.deepcopy(objects["sourceUnknownEvidence"])
        bundle["digest"] = f"sha256:{index + 1:064x}"
        bundle["evidence"]["derived_from"] = []
        bundle["evidence"]["supersedes"] = None
        bundle["evidence"]["conflicts_with"] = []
        bundle["evidence"]["correction_reason"] = None
        if conflict_chain:
            conflict_chain[-1]["evidence"]["derived_from"] = [bundle["digest"]]
        conflict_chain.append(bundle)
    conflict_root["evidence"]["derived_from"] = []
    conflict_root["evidence"]["supersedes"] = None
    conflict_root["evidence"]["conflicts_with"] = [conflict_chain[0]["digest"]]
    conflict_root["evidence"]["correction_reason"] = None
    conflict_depth_graph["roots"] = [conflict_root["digest"]]
    conflict_depth_graph["bundles"] = [conflict_root, *conflict_chain]
    expect_rejected(
        lambda: verify_graph(conflict_depth_graph),
        "conflict-only lineage depth",
    )

    public_to_owner = copy.deepcopy(objects["ownerGraph"])
    public_to_owner["bundles"][1]["evidence"]["access"] = {"visibility": "public"}
    public_to_owner["bundles"][1]["digest"] = digest(
        "evidence", public_to_owner["bundles"][1]["evidence"]
    )
    public_to_owner["roots"] = [public_to_owner["bundles"][1]["digest"]]
    expect_rejected(lambda: verify_graph(public_to_owner), "public to owner lineage")

    bad_request_binding = copy.deepcopy(objects["completeReceipt"])
    bad_request_binding["receipt"]["request_digest"] = "sha256:" + "0" * 64
    bad_request_binding["receipt_digest"] = digest(
        "receipt", bad_request_binding["receipt"]
    )
    expect_rejected(
        lambda: verify_receipt(bad_request_binding, objects["consultation"]),
        "receipt request binding",
    )

    excessive_charge = copy.deepcopy(objects["completeReceipt"])
    excessive_charge["receipt"]["economics"]["charged_amount"] = "11"
    excessive_charge["receipt_digest"] = digest("receipt", excessive_charge["receipt"])
    expect_rejected(
        lambda: verify_receipt(excessive_charge, objects["consultation"]),
        "charge above reservation",
    )

    unknown_as_zero = copy.deepcopy(objects["reconciliationReceipt"])
    unknown_as_zero["receipt"]["economics"]["charged_amount"] = "0"
    unknown_as_zero["receipt_digest"] = digest("receipt", unknown_as_zero["receipt"])
    expect_rejected(
        lambda: verify_receipt(unknown_as_zero, objects["consultation"]),
        "unknown charge rewritten as zero",
    )

    padded_signature = copy.deepcopy(objects["acknowledgment"])
    padded_signature["signature"] += "="
    expect_rejected(
        lambda: verify_receipt(padded_signature, objects["consultation"]),
        "padded signature",
    )


def verify_fixture(fixture: dict[str, Any]) -> int:
    expected = build_vectors()
    require(fixture == expected, "fixture differs from independently generated vectors")
    for literal in fixture["literals"].values():
        require(
            canonical_json(literal["value"]) == literal["canonical"],
            "canonical literal",
        )
        require(
            digest(literal["domain"], literal["value"]) == literal["digest"],
            "literal digest",
        )
    for graph_literal in fixture["graphs"].values():
        require(
            canonical_json(graph_literal["value"]) == graph_literal["canonical"],
            "graph literal",
        )
    objects = fixture["objects"]
    verify_graph(objects["publicGraph"])
    verify_graph(objects["ownerGraph"])
    require(
        objects["resultManifest"]["evidence_digests"]
        == objects["publicGraph"]["roots"],
        "result roots",
    )

    receipts = [
        objects["acknowledgment"],
        objects["pendingReceipt"],
        objects["completeReceipt"],
        objects["partialReceipt"],
        objects["rejectedReceipt"],
        objects["reconciliationReceipt"],
    ]
    for item in receipts:
        verify_receipt(item, objects["consultation"])
    require(objects["acknowledgment"]["receipt"]["sequence"] == 0, "ack sequence")
    require(
        objects["acknowledgment"]["receipt"]["previous_receipt_digest"] is None,
        "ack predecessor",
    )

    pending = objects["pendingReceipt"]
    for terminal_name in (
        "completeReceipt",
        "partialReceipt",
        "rejectedReceipt",
        "reconciliationReceipt",
    ):
        terminal = objects[terminal_name]
        require(
            terminal["receipt"]["sequence"] == pending["receipt"]["sequence"] + 1,
            "sequence transition",
        )
        require(
            terminal["receipt"]["previous_receipt_digest"] == pending["receipt_digest"],
            "receipt lineage",
        )
    verify_invalid_cases(objects)
    return len(fixture["literals"])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--fixture",
        type=Path,
        default=Path(__file__).parents[1]
        / "test"
        / "fixtures"
        / "v2-evidence-receipts.json",
    )
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args()
    if args.write:
        args.fixture.parent.mkdir(parents=True, exist_ok=True)
        args.fixture.write_text(
            json.dumps(build_vectors(), indent=2) + "\n", encoding="utf-8"
        )
    count = verify_fixture(json.loads(args.fixture.read_text(encoding="utf-8")))
    print(f"verified {count} Gossip v2 evidence and receipt vectors in {args.fixture}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (KeyError, TypeError, VectorError, ValueError) as error:
        print(f"vector verification failed: {error}", file=sys.stderr)
        raise SystemExit(1)
