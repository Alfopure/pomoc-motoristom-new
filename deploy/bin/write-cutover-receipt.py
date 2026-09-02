#!/usr/bin/env python3

import datetime
import hashlib
import json
import os
import re
import stat
import sys


def parse_bool(value: str) -> bool:
    if value not in ("true", "false"):
        raise SystemExit("invalid receipt boolean")
    return value == "true"


def record_hash(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def validate_existing_chain(contents: bytes, expected_identity: dict[str, object]) -> bytes:
    if not contents or not contents.endswith(b"\n"):
        raise SystemExit("cutover receipt chain is incomplete")

    lines = contents.splitlines(keepends=True)
    if len(lines) != 1:
        raise SystemExit("cutover receipt already has a terminal record")

    previous_payload = b""
    for index, line in enumerate(lines):
        try:
            record = json.loads(line)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise SystemExit("cutover receipt chain contains invalid JSON") from error
        if not isinstance(record, dict):
            raise SystemExit("cutover receipt chain contains an invalid record")
        expected_previous = None if index == 0 else record_hash(previous_payload)
        if record.get("previous_record_sha256") != expected_previous:
            raise SystemExit("cutover receipt chain hash mismatch")
        if any(record.get(key) != value for key, value in expected_identity.items()):
            raise SystemExit("cutover receipt identity mismatch")
        previous_payload = line

    first = json.loads(lines[0])
    if first.get("status") != "in_progress" or first.get("stage") != "cutover_started":
        raise SystemExit("cutover receipt has no valid initial record")
    return lines[-1]


def main() -> None:
    if len(sys.argv) != 24:
        raise SystemExit("invalid cutover receipt argument count")

    (
        receipt_path,
        write_mode,
        status,
        stage,
        release_version,
        image,
        image_id,
        build_context_sha256,
        build_args_sha256,
        checksums_sha256,
        gate_snapshot_id,
        gate_run_id,
        gate_report_sha256,
        continuity_policy_sha256,
        continuity_anchor_sha256,
        live_watermark_anchor_sha256,
        live_storage_anchor_sha256,
        live_storage_transition_manifest_sha256,
        component_report_sha256_json,
        gate_validated_at_utc,
        compose_healthy,
        https_healthy,
        stack_removed,
    ) = sys.argv[1:]

    allowed_statuses = {"in_progress", "success", "failure"}
    allowed_stages = {
        "cutover_started",
        "runtime_env_install",
        "compose_config",
        "compose_start",
        "https_health",
        "receipt_finalize",
        "cutover_complete",
    }
    if write_mode not in ("create", "append"):
        raise SystemExit("invalid receipt write mode")
    if status not in allowed_statuses or stage not in allowed_stages:
        raise SystemExit("invalid receipt status or stage")

    if write_mode == "create" and (status != "in_progress" or stage != "cutover_started"):
        raise SystemExit("cutover receipt create must record cutover_started")
    if write_mode == "append" and status not in ("success", "failure"):
        raise SystemExit("cutover receipt append must be terminal")
    if not re.fullmatch(r"[0-9]{8}T[0-9]{6}Z", gate_snapshot_id):
        raise SystemExit("invalid gate snapshot ID")
    if not re.fullmatch(r"[0-9]{8}T[0-9]{6}Z-[0-9]+-[0-9]+", gate_run_id):
        raise SystemExit("invalid gate run ID")
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", image_id):
        raise SystemExit("invalid image ID")

    sha256_fields = (
        build_context_sha256,
        build_args_sha256,
        checksums_sha256,
        gate_report_sha256,
        continuity_policy_sha256,
        continuity_anchor_sha256,
        live_watermark_anchor_sha256,
        live_storage_anchor_sha256,
        live_storage_transition_manifest_sha256,
    )
    if any(len(value) != 64 or any(character not in "0123456789abcdef" for character in value) for value in sha256_fields):
        raise SystemExit("invalid receipt SHA-256 binding")
    try:
        component_report_sha256 = json.loads(component_report_sha256_json)
    except json.JSONDecodeError as error:
        raise SystemExit("invalid component report binding") from error
    if not isinstance(component_report_sha256, dict) or sorted(component_report_sha256) != [
        "application",
        "auth",
        "config",
        "database",
        "storage",
    ]:
        raise SystemExit("invalid component report hash set")
    if any(
        not isinstance(value, str)
        or len(value) != 64
        or any(character not in "0123456789abcdef" for character in value)
        for value in component_report_sha256.values()
    ):
        raise SystemExit("invalid component report hash")

    identity = {
        "release_version": release_version,
        "image": image,
        "image_id": image_id,
        "build_context_sha256": build_context_sha256,
        "build_args_sha256": build_args_sha256,
        "sha256sums_sha256": checksums_sha256,
        "gate_snapshot_id": gate_snapshot_id,
        "gate_run_id": gate_run_id,
        "gate_report_sha256": gate_report_sha256,
        "continuity_policy_sha256": continuity_policy_sha256,
        "continuity_anchor_sha256": continuity_anchor_sha256,
        "live_watermark_anchor_sha256": live_watermark_anchor_sha256,
        "live_storage_anchor_sha256": live_storage_anchor_sha256,
        "live_storage_transition_manifest_sha256": live_storage_transition_manifest_sha256,
        "component_report_sha256": component_report_sha256,
        "gate_validated_at_utc": gate_validated_at_utc,
    }
    record = {
        "receipt_schema_version": 2,
        "previous_record_sha256": None,
        "recorded_at_utc": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "status": status,
        "stage": stage,
        **identity,
        "evidence_scope": "predeployment_gate_plus_local_https",
        "dns_expected_ipv4": "195.201.36.90",
        "dns_points_to_target": True,
        "predeployment_source_write_freeze_active": True,
        "predeployment_target_jobs_active": False,
        "scheduler_enabled": False,
        "compose_healthy": parse_bool(compose_healthy),
        "https_healthy": parse_bool(https_healthy),
        "stack_removed": parse_bool(stack_removed),
    }
    nofollow = getattr(os, "O_NOFOLLOW", 0)
    if write_mode == "create":
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | nofollow
        descriptor = os.open(receipt_path, flags, 0o600)
    else:
        flags = os.O_RDWR | os.O_APPEND | nofollow
        descriptor = os.open(receipt_path, flags)

    with os.fdopen(descriptor, "r+b", closefd=True) as receipt_file:
        metadata = os.fstat(receipt_file.fileno())
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            raise SystemExit("cutover receipt is not a private regular file")
        if stat.S_IMODE(metadata.st_mode) != 0o600:
            raise SystemExit("cutover receipt must have mode 0600")
        if write_mode == "append":
            receipt_file.seek(0)
            previous_payload = validate_existing_chain(receipt_file.read(), identity)
            record["previous_record_sha256"] = record_hash(previous_payload)
        payload = (json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")
        receipt_file.write(payload)
        receipt_file.flush()
        os.fsync(receipt_file.fileno())


if __name__ == "__main__":
    main()
