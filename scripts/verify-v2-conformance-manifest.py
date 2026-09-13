"""Independently verify the Gossip v2 acceptance-manifest vector."""

import argparse
import hashlib
import json
import re
import runpy
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).parent.parent
PROTOCOL = "gossip/2-draft.1"
SCENARIOS = {
    "artifact_install",
    "installed_cli_process",
    "mcp_http_parity",
    "authentication_fail_closed",
    "session_scope_escape",
    "public_submission_transport",
    "operation_exactly_once",
    "operation_conflict",
    "zero_cost_reconciliation",
    "persistence_fault_recovery",
    "evidence_finality_reorg",
    "correction_supersession",
    "owner_isolation",
    "privacy_canary_scan",
    "independent_vectors",
    "clean_checkout_reproduction",
}
CAPABILITIES = {
    "atomic_consult",
    "durable_operations",
    "signed_receipts",
    "evidence",
    "session_keys",
    "public_submission",
    "private_submission",
    "http",
    "tasks",
}
CORE_CAPABILITIES = {
    "atomic_consult",
    "durable_operations",
    "signed_receipts",
    "evidence",
}
PROCESS_EVIDENCE_SCENARIOS = {
    "mcp_http_parity",
    "privacy_canary_scan",
    "operation_exactly_once",
    "operation_conflict",
    "authentication_fail_closed",
    "session_scope_escape",
    "public_submission_transport",
    "zero_cost_reconciliation",
    "persistence_fault_recovery",
    "evidence_finality_reorg",
    "correction_supersession",
    "owner_isolation",
}
SHA256_PREFIX = "sha256:"
MAX_UNIX_SECONDS = 253_402_300_799
MAX_REFERENCE_BYTES = 1_000_000_000
OS_NAMES = {"aix", "darwin", "freebsd", "linux", "openbsd", "win32"}
ARCHITECTURES = {
    "arm",
    "arm64",
    "ia32",
    "loong64",
    "mips",
    "mipsel",
    "ppc",
    "ppc64",
    "riscv64",
    "s390",
    "s390x",
    "x64",
}
REVISION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$")
VERSION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$")

parser = argparse.ArgumentParser()
parser.add_argument("--manifest", type=Path)
parser.add_argument("--replay-manifest", type=Path)
parser.add_argument("--write-replay-attestation", type=Path)
arguments = parser.parse_args()
manifest_path = (
    arguments.manifest.resolve()
    if arguments.manifest is not None
    else ROOT / "test" / "fixtures" / "v2-conformance.json"
)
verify_referenced_files = arguments.manifest is not None
manifest_root = manifest_path.parent
replay_manifest_path = (
    arguments.replay_manifest.resolve()
    if arguments.replay_manifest is not None
    else None
)

if replay_manifest_path is not None and arguments.manifest is None:
    raise AssertionError("--replay-manifest requires --manifest")
if arguments.write_replay_attestation is not None and replay_manifest_path is None:
    raise AssertionError("--write-replay-attestation requires --replay-manifest")


def exact_keys(value, expected):
    assert isinstance(value, dict)
    assert set(value) == set(expected)


def digest(value):
    canonicalizer = runpy.run_path(str(Path(__file__).parent / "verify-v2-vectors.py"))[
        "canonical_json"
    ]
    payload = f"{PROTOCOL}\nconformance\n{canonicalizer(value)}".encode("utf-8")
    return SHA256_PREFIX + hashlib.sha256(payload).hexdigest()


def verify_sha256(value):
    assert isinstance(value, str)
    assert value.startswith(SHA256_PREFIX)
    assert len(value) == len(SHA256_PREFIX) + 64
    assert all(character in "0123456789abcdef" for character in value[7:])


def verify_integer(value, minimum, maximum):
    assert isinstance(value, int) and not isinstance(value, bool)
    assert minimum <= value <= maximum


def verify_revision(value):
    assert isinstance(value, str) and REVISION.fullmatch(value)


def verify_version(value):
    assert isinstance(value, str) and VERSION.fullmatch(value)


def verify_short_text(value):
    assert isinstance(value, str) and 1 <= len(value) <= 256
    assert all(ord(character) >= 32 and ord(character) != 127 for character in value)


def verify_relative_path(value):
    assert isinstance(value, str) and 1 <= len(value) <= 256
    assert "\\" not in value
    assert not value.startswith("/")
    assert re.match(r"^[A-Za-z]:", value) is None
    assert all(part not in {"", ".", ".."} for part in value.split("/"))


def verify_evidence(reference):
    exact_keys(reference, {"path", "sha256", "bytes"})
    verify_relative_path(reference["path"])
    verify_sha256(reference["sha256"])
    verify_integer(reference["bytes"], 0, MAX_REFERENCE_BYTES)
    if verify_referenced_files:
        referenced_path = (manifest_root / reference["path"]).resolve()
        referenced_path.relative_to(manifest_root)
        content = referenced_path.read_bytes()
        assert len(content) == reference["bytes"]
        assert (
            SHA256_PREFIX + hashlib.sha256(content).hexdigest() == reference["sha256"]
        )


fixture = json.loads(manifest_path.read_text(encoding="utf-8"))
exact_keys(fixture, {"schema", "statement", "content_address"})
assert fixture["schema"] == "gossip.acceptance-envelope.v1"

statement = fixture["statement"]
exact_keys(
    statement,
    {
        "schema",
        "suite_revision",
        "protocol",
        "generated_at",
        "source",
        "artifacts",
        "runtime",
        "revisions",
        "fixtures",
        "scenarios",
        "capabilities",
        "decision",
    },
)
assert statement["schema"] == "gossip.acceptance-statement.v1"
assert statement["suite_revision"] == "gossip-v2-conformance-2026-09-11.12"
assert statement["protocol"] == PROTOCOL
assert statement["decision"] in {"verified", "blocked"}
verify_integer(statement["generated_at"], 0, MAX_UNIX_SECONDS)

exact_keys(statement["source"], {"repository", "commit", "dirty"})
assert statement["source"]["repository"] == "https://github.com/gossip-dev/gossip"
assert statement["source"]["dirty"] is False
assert re.fullmatch(r"[0-9a-f]{40}", statement["source"]["commit"])

exact_keys(statement["artifacts"], {"gossip", "sherwood"})
exact_keys(statement["artifacts"]["gossip"], {"package", "version", "sha256", "bytes"})
assert statement["artifacts"]["gossip"]["package"] == "@gossip/agent-kit"
verify_version(statement["artifacts"]["gossip"]["version"])
verify_sha256(statement["artifacts"]["gossip"]["sha256"])
verify_integer(statement["artifacts"]["gossip"]["bytes"], 1, MAX_REFERENCE_BYTES)
exact_keys(
    statement["artifacts"]["sherwood"],
    {"repository", "commit", "assembly", "image_digest"},
)
sherwood = statement["artifacts"]["sherwood"]
assert sherwood["repository"] == "https://github.com/gossip-dev/sherwood"
assembly = sherwood["assembly"]
if assembly is not None:
    exact_keys(assembly, {"sha256", "bytes"})
    verify_sha256(assembly["sha256"])
    verify_integer(assembly["bytes"], 1, MAX_REFERENCE_BYTES)
assert (
    sherwood["commit"] is None and assembly is None and sherwood["image_digest"] is None
) or (
    sherwood["commit"] is not None
    and (assembly is not None or sherwood["image_digest"] is not None)
)
if sherwood["commit"] is not None:
    assert re.fullmatch(r"[0-9a-f]{40}", sherwood["commit"])
if sherwood["image_digest"] is not None:
    verify_sha256(sherwood["image_digest"])
    assert sherwood["commit"] is not None

exact_keys(
    statement["runtime"],
    {
        "os",
        "architecture",
        "node",
        "npm",
        "python",
        "dotnet",
        "docker",
        "postgresql",
    },
)
assert statement["runtime"]["os"] in OS_NAMES
assert statement["runtime"]["architecture"] in ARCHITECTURES
for runtime_name in ["node", "npm", "python"]:
    verify_version(statement["runtime"][runtime_name])
for runtime_name in ["dotnet", "docker", "postgresql"]:
    runtime_version = statement["runtime"][runtime_name]
    if runtime_version is not None:
        verify_version(runtime_version)
exact_keys(
    statement["revisions"],
    {
        "schema",
        "auth",
        "mcp",
        "engine",
        "database_migrations",
        "fixture_suite",
    },
)
assert statement["revisions"]["schema"] == "2026-09-09"
assert statement["revisions"]["auth"] == "gossip-eip191-v2"
assert statement["revisions"]["mcp"] == "2025-11-25"
for revision_name in ["engine", "database_migrations"]:
    revision = statement["revisions"][revision_name]
    if revision is not None:
        verify_revision(revision)
verify_revision(statement["revisions"]["fixture_suite"])

assert isinstance(statement["fixtures"], list)
assert 1 <= len(statement["fixtures"]) <= 64
fixture_names = [item["name"] for item in statement["fixtures"]]
fixture_paths = [item["path"] for item in statement["fixtures"]]
assert len(set(fixture_names)) == len(fixture_names)
assert len(set(fixture_paths)) == len(fixture_paths)

for item in statement["fixtures"]:
    exact_keys(item, {"name", "path", "sha256", "bytes"})
    verify_revision(item["name"])
    verify_relative_path(item["path"])
    verify_sha256(item["sha256"])
    verify_integer(item["bytes"], 1, MAX_REFERENCE_BYTES)
    if verify_referenced_files:
        verify_evidence(
            {
                "path": item["path"],
                "sha256": item["sha256"],
                "bytes": item["bytes"],
            }
        )

assert isinstance(statement["scenarios"], list)
assert len(statement["scenarios"]) == len(SCENARIOS)
scenarios = {item["id"]: item for item in statement["scenarios"]}
assert set(scenarios) == SCENARIOS
assert len(statement["scenarios"]) == len(SCENARIOS)
for scenario in scenarios.values():
    if scenario["status"] == "verified":
        exact_keys(scenario, {"id", "status", "assertions", "evidence"})
        verify_integer(scenario["assertions"], 1, 1_000_000)
        assert isinstance(scenario["evidence"], list)
        assert 1 <= len(scenario["evidence"]) <= 64
        for reference in scenario["evidence"]:
            verify_evidence(reference)
    else:
        exact_keys(scenario, {"id", "status", "reason", "next_action"})
        assert scenario["status"] in {"blocked", "not_applicable"}
        verify_short_text(scenario["reason"])
        verify_short_text(scenario["next_action"])

process_evidence_required = any(
    scenarios[scenario_id]["status"] == "verified"
    for scenario_id in PROCESS_EVIDENCE_SCENARIOS
)
if process_evidence_required:
    assert sherwood["commit"] is not None
    assert assembly is not None
    assert statement["runtime"]["dotnet"] is not None
    assert statement["runtime"]["docker"] is not None
    assert statement["runtime"]["postgresql"] is not None
    assert statement["revisions"]["engine"] is not None
    assert statement["revisions"]["database_migrations"] is not None

assert isinstance(statement["capabilities"], list)
assert len(statement["capabilities"]) == len(CAPABILITIES)
capabilities = {item["name"]: item for item in statement["capabilities"]}
assert set(capabilities) == CAPABILITIES
assert len(statement["capabilities"]) == len(CAPABILITIES)
for capability in capabilities.values():
    if capability["state"] == "verified":
        exact_keys(
            capability,
            {"name", "state", "evidence_revision", "evidence_scenarios"},
        )
        verify_revision(capability["evidence_revision"])
        assert isinstance(capability["evidence_scenarios"], list)
        assert 1 <= len(capability["evidence_scenarios"]) <= len(SCENARIOS)
        assert set(capability["evidence_scenarios"]).issubset(SCENARIOS)
        assert len(set(capability["evidence_scenarios"])) == len(
            capability["evidence_scenarios"]
        )
        assert all(
            scenarios[scenario_id]["status"] == "verified"
            for scenario_id in capability["evidence_scenarios"]
        )
    else:
        exact_keys(capability, {"name", "state", "reason", "next_action"})
        assert capability["state"] in {"installed", "blocked", "not_applicable"}
        verify_short_text(capability["reason"])
        verify_short_text(capability["next_action"])

if statement["decision"] == "verified":
    assert all(item["status"] == "verified" for item in scenarios.values())
    assert all(capabilities[name]["state"] == "verified" for name in CORE_CAPABILITIES)
    assert sherwood["commit"] is not None
    assert sherwood["image_digest"] is not None
    assert all(
        statement["runtime"][name] is not None
        for name in ["dotnet", "docker", "postgresql"]
    )
    assert statement["revisions"]["engine"] is not None
    assert statement["revisions"]["database_migrations"] is not None

content_address = fixture["content_address"]
exact_keys(content_address, {"algorithm", "digest"})
assert content_address["algorithm"] == "sha256"
verify_sha256(content_address["digest"])
assert content_address["digest"] == digest(statement)


def replay_projection(value):
    """Return fields that must remain stable across clean-checkout replays."""
    return {
        "schema": value["schema"],
        "suite_revision": value["suite_revision"],
        "protocol": value["protocol"],
        "source": value["source"],
        "artifacts": value["artifacts"],
        "runtime": value["runtime"],
        "revisions": value["revisions"],
        "fixtures": value["fixtures"],
        "scenarios": [
            {
                "id": scenario["id"],
                "status": scenario["status"],
                **(
                    {"assertions": scenario["assertions"]}
                    if scenario["status"] == "verified"
                    else {}
                ),
            }
            for scenario in value["scenarios"]
        ],
        "capabilities": [
            {"name": capability["name"], "state": capability["state"]}
            for capability in value["capabilities"]
        ],
        "decision": value["decision"],
    }


def write_replay_attestation(primary_fixture, replay_fixture):
    """Persist the content-addressed proof derived from two verified manifests."""
    attestation = {
        "schema": "gossip.replay-attestation.v1",
        "protocol": PROTOCOL,
        "suite_revision": primary_fixture["statement"]["suite_revision"],
        "primary_manifest": primary_fixture["content_address"]["digest"],
        "replay_manifest": replay_fixture["content_address"]["digest"],
        "projection_digest": digest(
            {
                "schema": "gossip.replay-projection.v1",
                "projection": replay_projection(primary_fixture["statement"]),
            }
        ),
        "result": "matched",
    }
    envelope = {
        "schema": "gossip.replay-attestation-envelope.v1",
        "attestation": attestation,
        "content_address": {
            "algorithm": "sha256",
            "digest": digest(attestation),
        },
    }
    output_path = arguments.write_replay_attestation.resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("x", encoding="utf-8", newline="\n") as output:
        json.dump(envelope, output, ensure_ascii=False, indent=2)
        output.write("\n")


if replay_manifest_path is None:
    print(f"v2 content-addressed acceptance manifest verified: {statement['decision']}")
else:
    replay = subprocess.run(
        [
            sys.executable,
            str(Path(__file__).resolve()),
            "--manifest",
            str(replay_manifest_path),
        ],
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=30,
    )
    assert replay.returncode == 0, "the replay manifest failed independent verification"
    replay_fixture = json.loads(replay_manifest_path.read_text(encoding="utf-8"))
    assert replay_projection(statement) == replay_projection(
        replay_fixture["statement"]
    ), "clean-checkout replay changed the acceptance decision or deterministic inputs"
    if arguments.write_replay_attestation is not None:
        write_replay_attestation(fixture, replay_fixture)
    print("v2 acceptance manifests independently verified and replay matched")
