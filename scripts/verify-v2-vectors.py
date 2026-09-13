#!/usr/bin/env python3
"""Generate and independently verify the Gossip v2 canonical JSON vectors."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import sys
from pathlib import Path
from typing import Any


PROTOCOL_REVISION = "gossip/2-draft.1"
DOMAINS = ("request", "evidence", "receipt")
MAX_SAFE_INTEGER = 2**53 - 1
MAX_BYTES = 65_536
MAX_DEPTH = 16
MAX_ARRAY_ITEMS = 256
MAX_OBJECT_MEMBERS = 64
MAX_NODES = 4_096


class VectorError(ValueError):
    """An input is outside the narrowed v2 canonical profile."""


def _utf8(value: str) -> bytes:
    try:
        return value.encode("utf-8")
    except UnicodeEncodeError as error:
        raise VectorError("lone surrogate") from error


def _utf16_key(value: str) -> bytes:
    return _utf8(value).decode("utf-8").encode("utf-16-be")


def _validate(
    value: Any, *, depth: int = 0, state: dict[str, int] | None = None
) -> None:
    if state is None:
        state = {"nodes": 0}

    state["nodes"] += 1
    if state["nodes"] > MAX_NODES:
        raise VectorError("node limit")
    if depth > MAX_DEPTH:
        raise VectorError("depth limit")

    if value is None or isinstance(value, bool):
        return

    if isinstance(value, int):
        if abs(value) > MAX_SAFE_INTEGER:
            raise VectorError("unsafe integer")
        return

    if isinstance(value, float):
        raise VectorError("number must be an integer")

    if isinstance(value, str):
        _utf8(value)
        return

    if isinstance(value, list):
        if len(value) > MAX_ARRAY_ITEMS:
            raise VectorError("array limit")
        for child in value:
            _validate(child, depth=depth + 1, state=state)
        return

    if isinstance(value, dict):
        if len(value) > MAX_OBJECT_MEMBERS:
            raise VectorError("object limit")
        for key, child in value.items():
            if not isinstance(key, str):
                raise VectorError("object key must be a string")
            _utf8(key)
            _validate(child, depth=depth + 1, state=state)
        return

    raise VectorError("unsupported value")


def _bounded(serialized: str) -> str:
    if len(_utf8(serialized)) > MAX_BYTES:
        raise VectorError("byte limit")
    return serialized


def _canonical_json(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, str):
        return _bounded(json.dumps(value, ensure_ascii=False, separators=(",", ":")))
    if isinstance(value, list):
        children = []
        size = 2
        for child in value:
            encoded_child = _canonical_json(child)
            size += len(_utf8(encoded_child)) + (1 if children else 0)
            if size > MAX_BYTES:
                raise VectorError("byte limit")
            children.append(encoded_child)
        return "[" + ",".join(children) + "]"
    if isinstance(value, dict):
        members = []
        size = 2
        for key in sorted(value, key=_utf16_key):
            encoded_key = json.dumps(key, ensure_ascii=False, separators=(",", ":"))
            encoded_value = _canonical_json(value[key])
            member = f"{encoded_key}:{encoded_value}"
            size += len(_utf8(member)) + (1 if members else 0)
            if size > MAX_BYTES:
                raise VectorError("byte limit")
            members.append(member)
        return "{" + ",".join(members) + "}"
    raise AssertionError("validation should reject unsupported values")


def canonical_json(value: Any) -> str:
    """Serialize the narrowed profile with JCS-style strings and UTF-16 keys."""

    _validate(value)
    return _canonical_json(value)


def canonical_bytes(value: Any) -> bytes:
    encoded = _utf8(canonical_json(value))
    if len(encoded) > MAX_BYTES:
        raise VectorError("byte limit")
    return encoded


def _reject_constant(value: str) -> None:
    raise VectorError(f"non-finite number: {value}")


def _object_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise VectorError("duplicate key")
        result[key] = value
    return result


def parse_raw(raw: bytes | str) -> Any:
    try:
        raw_bytes = raw.encode("utf-8") if isinstance(raw, str) else raw
    except UnicodeEncodeError as error:
        raise VectorError("invalid UTF-8") from error
    if len(raw_bytes) > MAX_BYTES:
        raise VectorError("byte limit")
    try:
        text = raw_bytes.decode("utf-8")
        value = json.loads(
            text,
            object_pairs_hook=_object_pairs,
            parse_constant=_reject_constant,
        )
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise VectorError("invalid JSON") from error

    canonical = canonical_bytes(value)
    if canonical != raw_bytes:
        raise VectorError("noncanonical JSON")
    return value


def digest(domain: str, canonical: str) -> str:
    if domain not in DOMAINS:
        raise VectorError("invalid digest domain")
    payload = f"{PROTOCOL_REVISION}\n{domain}\n{canonical}".encode("utf-8")
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def _valid_case(name: str, value: Any) -> dict[str, Any]:
    canonical = canonical_json(value)
    canonical_bytes_value = _utf8(canonical)
    if len(canonical_bytes_value) > MAX_BYTES:
        raise AssertionError(f"vector {name} exceeds the byte limit")
    return {
        "name": name,
        "value": value,
        "canonical": canonical,
        "digests": {domain: digest(domain, canonical) for domain in DOMAINS},
    }


def _invalid_case(
    name: str, kind: str, *, raw: str | None = None, raw_bytes: bytes | None = None
) -> dict[str, Any]:
    case: dict[str, Any] = {"name": name, "kind": kind}
    if raw is not None:
        case["raw"] = raw
    if raw_bytes is not None:
        case["rawBase64"] = base64.b64encode(raw_bytes).decode("ascii")
    return case


def build_fixture() -> dict[str, Any]:
    nested_depth = "0"
    for _ in range(MAX_DEPTH + 1):
        nested_depth = "[" + nested_depth + "]"

    oversized_text = json.dumps("x" * MAX_BYTES, ensure_ascii=False)
    oversized_array = "[" + ",".join("0" for _ in range(MAX_ARRAY_ITEMS + 1)) + "]"
    oversized_object = (
        "{" + ",".join(f'"{index}":0' for index in range(MAX_OBJECT_MEMBERS + 1)) + "}"
    )
    oversized_nodes = (
        "["
        + ",".join("[" + ",".join("0" for _ in range(255)) + "]" for _ in range(16))
        + "]"
    )

    valid = [
        _valid_case(
            "simple-values",
            {
                "null": None,
                "boolean": True,
                "integer": -42,
                "text": 'line\n\u00e9"\\\t',
                "array": [0, 1, False],
            },
        ),
        _valid_case("integer-looking-keys", {"2": "two", "10": "ten", "1": "one"}),
        _valid_case(
            "utf16-non-bmp-before-bmp", {"\ue000": "bmp", "\U00010000": "nonbmp"}
        ),
        _valid_case(
            "composed-and-decomposed", {"\u00e9": "composed", "e\u0301": "decomposed"}
        ),
        _valid_case(
            "consultation-envelope",
            {
                "protocol": PROTOCOL_REVISION,
                "schema_revision": "2026-09-09",
                "auth_profile": "gossip-eip191-v2",
                "operation_id": "vector-consult-01",
                "actor": {
                    "chain_id": "4663",
                    "address": "0x" + "1" * 40,
                },
                "subject": {
                    "kind": "token",
                    "chain_id": "4663",
                    "address": "0x" + "2" * 40,
                },
                "capability": "token_overview",
                "endpoint": "https://engine.test/mcp",
                "audience": "https://engine.test/",
                "quality": {
                    "tier": "standard",
                    "max_age_seconds": 3600,
                    "finality": "latest",
                    "allow_partial": False,
                },
                "max_cost": {
                    "unit": "earned_credit",
                    "amount": "0",
                },
                "deadline": 1893456000,
            },
        ),
    ]

    invalid = [
        _invalid_case("duplicate-keys", "duplicate-key", raw='{"a":1,"a":2}'),
        _invalid_case("whitespace", "noncanonical", raw='{"a": 1}'),
        _invalid_case("negative-zero", "negative-zero", raw="-0"),
        _invalid_case("unsafe-integer", "unsafe-integer", raw="9007199254740992"),
        _invalid_case("fractional-number", "fractional-number", raw="1.5"),
        _invalid_case("lone-surrogate", "lone-surrogate", raw='"\\ud800"'),
        _invalid_case("depth-limit", "depth-limit", raw=nested_depth),
        _invalid_case("byte-limit", "byte-limit", raw=oversized_text),
        _invalid_case("array-limit", "array-limit", raw=oversized_array),
        _invalid_case("object-limit", "object-limit", raw=oversized_object),
        _invalid_case("node-limit", "node-limit", raw=oversized_nodes),
        _invalid_case("invalid-utf8", "invalid-utf8", raw_bytes=b'{"x":"\xff"}'),
    ]

    return {
        "protocolRevision": PROTOCOL_REVISION,
        "limits": {
            "maxBytes": MAX_BYTES,
            "maxDepth": MAX_DEPTH,
            "maxArrayItems": MAX_ARRAY_ITEMS,
            "maxObjectMembers": MAX_OBJECT_MEMBERS,
            "maxNodes": MAX_NODES,
        },
        "valid": valid,
        "invalid": invalid,
    }


def _load_fixture(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as stream:
        fixture = json.load(stream)
    if not isinstance(fixture, dict):
        raise VectorError("fixture root must be an object")
    return fixture


def verify_fixture(fixture: dict[str, Any]) -> int:
    expected = build_fixture()
    if fixture != expected:
        raise VectorError("fixture differs from independently generated vectors")

    for case in fixture["valid"]:
        parsed = parse_raw(case["canonical"])
        if parsed != case["value"]:
            raise VectorError(f"valid vector does not round-trip: {case['name']}")
        for domain in DOMAINS:
            if digest(domain, case["canonical"]) != case["digests"][domain]:
                raise VectorError(f"digest mismatch: {case['name']} / {domain}")

    for case in fixture["invalid"]:
        raw = (
            base64.b64decode(case["rawBase64"]) if "rawBase64" in case else case["raw"]
        )
        try:
            parse_raw(raw)
        except VectorError:
            continue
        raise VectorError(f"invalid vector was accepted: {case['name']}")
    return len(fixture["valid"]) + len(fixture["invalid"])


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--fixture",
        type=Path,
        default=Path(__file__).parents[1] / "test" / "fixtures" / "v2-canonical.json",
    )
    parser.add_argument(
        "--write",
        action="store_true",
        help="regenerate the fixture from the Python implementation",
    )
    args = parser.parse_args()

    if args.write:
        args.fixture.parent.mkdir(parents=True, exist_ok=True)
        args.fixture.write_text(
            json.dumps(build_fixture(), ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    count = verify_fixture(_load_fixture(args.fixture))
    print(f"verified {count} v2 canonical vectors in {args.fixture}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except VectorError as error:
        print(f"vector verification failed: {error}", file=sys.stderr)
        raise SystemExit(1)
