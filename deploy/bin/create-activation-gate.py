#!/usr/bin/env python3

"""Create a fast, read-only post-cutover activation gate.

The helper emits no stdout and never includes Management API credentials or
database rows in its output.  Only fixed aggregate SELECTs are sent to the two
Supabase projects.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import time
import urllib.error
import urllib.request
from pathlib import Path, PurePosixPath
from typing import Any, Callable


SOURCE_REF = "jcwbiulwuwyrnmzjjbgr"
TARGET_REF = "sjcsrygkkmersoczpunh"
PUBLIC_ORIGIN = "https://dispecing.linkapomoci.sk"
MANAGEMENT_ORIGIN = "https://api.supabase.com"
MAX_SMALL_FILE_BYTES = 1024 * 1024
MAX_API_RESPONSE_BYTES = 64 * 1024
MAX_HEALTH_RESPONSE_BYTES = 16 * 1024
MAX_VALIDATION_DURATION_SECONDS = 120
MAX_GATE_AGE_SECONDS = 300
MAX_PREDEPLOYMENT_GATE_TO_CUTOVER_SECONDS = 300
EXPECTED_JOB_CONTROLS = (
    "fleet.webdispecink.positions",
    "fleet.webdispecink.catalog",
    "fleet.commander.positions",
    "fleet.commander.catalog",
    "fleet.swhouse.occupancy",
    "fleet.swhouse.roster",
    "notifications.materialize",
    "telephony.recordings.sync",
    "telephony.transcripts.process",
    "telephony.viptel.reconcile",
    "infra.hetzner.audit",
)
REQUIRED_RELEASE_FILES = frozenset(
    {
        "image.tar.gz",
        "manifest.json",
        "compose.yml",
        "Caddyfile",
        "upstream.caddy",
        "bin/create-activation-gate.py",
    }
)
RELEASE_PATTERN = re.compile(r"hetzner-[A-Za-z0-9][A-Za-z0-9._-]{0,95}")
IMAGE_ID_PATTERN = re.compile(r"sha256:[0-9a-f]{64}")
SHA256_PATTERN = re.compile(r"[0-9a-f]{64}")
PROJECT_REF_PATTERN = re.compile(r"[a-z0-9]{20}")
ENV_KEY_PATTERN = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
UTC_PATTERN = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z")

SOURCE_STATE_QUERY = """select
  exists (
    select 1
    from pg_catalog.pg_db_role_setting as settings
    join pg_catalog.pg_database as databases
      on databases.oid = settings.setdatabase
    where databases.datname = pg_catalog.current_database()
      and settings.setrole = 0
      and 'default_transaction_read_only=on' = any(settings.setconfig)
  ) as database_default_read_only,
  (case when pg_catalog.to_regclass('cron.job') is null then 0
    else (select pg_catalog.count(*) from cron.job where active)
  end)::integer as active_cron_jobs;"""

_EXPECTED_JOB_CONTROLS_SQL = ",".join(
    "'" + job.replace("'", "''") + "'" for job in EXPECTED_JOB_CONTROLS
)
TARGET_STATE_QUERY = f"""select
  exists (
    select 1
    from pg_catalog.pg_db_role_setting as settings
    join pg_catalog.pg_database as databases
      on databases.oid = settings.setdatabase
    where databases.datname = pg_catalog.current_database()
      and settings.setrole = 0
      and 'default_transaction_read_only=on' = any(settings.setconfig)
  ) as database_default_read_only,
  (case when pg_catalog.to_regclass('cron.job') is null then 0
    else (select pg_catalog.count(*) from cron.job where active)
  end)::integer as active_cron_jobs,
  (select pg_catalog.count(*)::integer
    from public.motorist_job_controls) as job_controls_total,
  (select pg_catalog.count(*)::integer
    from public.motorist_job_controls
    where enabled) as job_controls_enabled,
  (select pg_catalog.count(*)::integer
    from public.motorist_job_controls
    where job_name = any(array[{_EXPECTED_JOB_CONTROLS_SQL}]::text[])
  ) as expected_job_controls_total;"""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


def format_utc(value: dt.datetime) -> str:
    return value.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_utc(value: object, field: str) -> dt.datetime:
    require(
        isinstance(value, str) and UTC_PATTERN.fullmatch(value) is not None,
        f"{field} is not a strict UTC timestamp",
    )
    try:
        return dt.datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(
            tzinfo=dt.timezone.utc
        )
    except ValueError as error:
        raise SystemExit(f"{field} is invalid") from error


def safe_absolute_path(path: Path) -> Path:
    absolute = Path(os.path.abspath(path))
    require(
        Path(os.path.realpath(absolute)) == absolute,
        f"{absolute} traverses a symlink",
    )
    return absolute


def require_directory(path: Path, *, private: bool) -> Path:
    absolute = safe_absolute_path(path)
    metadata = os.lstat(absolute)
    require(stat.S_ISDIR(metadata.st_mode), f"{absolute} is not a directory")
    require(not stat.S_ISLNK(metadata.st_mode), f"{absolute} must not be a symlink")
    if private:
        require(
            stat.S_IMODE(metadata.st_mode) & 0o077 == 0,
            f"{absolute} must be private",
        )
    return absolute


def open_regular_file(
    path: Path,
    *,
    private: bool,
    maximum_size: int | None,
) -> tuple[int, os.stat_result]:
    absolute = safe_absolute_path(path)
    before = os.lstat(absolute)
    require(stat.S_ISREG(before.st_mode), f"{absolute} is not a regular file")
    require(not stat.S_ISLNK(before.st_mode), f"{absolute} must not be a symlink")
    require(before.st_nlink == 1, f"{absolute} must have exactly one link")
    if private:
        require(stat.S_IMODE(before.st_mode) == 0o600, f"{absolute} must have mode 0600")
    if maximum_size is not None:
        require(before.st_size <= maximum_size, f"{absolute} is too large")
    descriptor = os.open(absolute, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    opened = os.fstat(descriptor)
    if (
        opened.st_dev,
        opened.st_ino,
        opened.st_size,
        opened.st_mtime_ns,
    ) != (
        before.st_dev,
        before.st_ino,
        before.st_size,
        before.st_mtime_ns,
    ):
        os.close(descriptor)
        raise SystemExit(f"{absolute} changed while it was opened")
    return descriptor, opened


def read_bytes(path: Path, *, private: bool, maximum_size: int = MAX_SMALL_FILE_BYTES) -> bytes:
    descriptor, opened = open_regular_file(
        path, private=private, maximum_size=maximum_size
    )
    try:
        chunks: list[bytes] = []
        remaining = maximum_size + 1
        while remaining:
            chunk = os.read(descriptor, min(65536, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        payload = b"".join(chunks)
        require(len(payload) <= maximum_size, f"{path} is too large")
        after = os.fstat(descriptor)
        require(
            (after.st_size, after.st_mtime_ns) == (opened.st_size, opened.st_mtime_ns),
            f"{path} changed while it was read",
        )
        return payload
    finally:
        os.close(descriptor)


def sha256_file(path: Path) -> str:
    descriptor, opened = open_regular_file(path, private=False, maximum_size=None)
    digest = hashlib.sha256()
    try:
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
        after = os.fstat(descriptor)
        require(
            (after.st_size, after.st_mtime_ns) == (opened.st_size, opened.st_mtime_ns),
            f"{path} changed while it was hashed",
        )
    finally:
        os.close(descriptor)
    return digest.hexdigest()


def read_json(path: Path, *, private: bool) -> tuple[dict[str, Any], bytes]:
    payload = read_bytes(path, private=private)
    try:
        value = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SystemExit(f"{path} is not valid JSON") from error
    require(isinstance(value, dict), f"{path} must contain a JSON object")
    return value, payload


def parse_env(path: Path) -> dict[str, str]:
    try:
        contents = read_bytes(path, private=True, maximum_size=256 * 1024).decode(
            "utf-8"
        )
    except UnicodeDecodeError as error:
        raise SystemExit("migration env is not UTF-8") from error
    require(contents.endswith("\n"), "migration env is incomplete")
    parsed: dict[str, str] = {}
    for line_number, line in enumerate(contents.splitlines(), 1):
        if not line:
            continue
        require("=" in line, f"migration env line {line_number} is malformed")
        key, encoded = line.split("=", 1)
        require(
            ENV_KEY_PATTERN.fullmatch(key) is not None,
            f"migration env line {line_number} has an invalid key",
        )
        require(key not in parsed, "migration env contains a duplicate key")
        if encoded.startswith('"'):
            try:
                value = json.loads(encoded)
            except json.JSONDecodeError as error:
                raise SystemExit(
                    f"migration env line {line_number} has invalid quoting"
                ) from error
            require(isinstance(value, str), "migration env value is not a string")
        elif encoded.startswith("'"):
            require(
                len(encoded) >= 2
                and encoded.endswith("'")
                and "'" not in encoded[1:-1],
                f"migration env line {line_number} has unsafe quoting",
            )
            value = encoded[1:-1]
        else:
            require(
                not any(character.isspace() or ord(character) < 32 for character in encoded),
                f"migration env line {line_number} has an unsafe value",
            )
            value = encoded
        require("\0" not in value, "migration env contains a null byte")
        parsed[key] = value
    required = (
        "SOURCE_PROJECT_REF",
        "TARGET_PROJECT_REF",
        "SOURCE_SUPABASE_ACCESS_TOKEN",
        "TARGET_SUPABASE_ACCESS_TOKEN",
    )
    require(all(parsed.get(key) for key in required), "migration env is incomplete")
    require(parsed["SOURCE_PROJECT_REF"] == SOURCE_REF, "source project ref mismatch")
    require(parsed["TARGET_PROJECT_REF"] == TARGET_REF, "target project ref mismatch")
    for key in ("SOURCE_SUPABASE_ACCESS_TOKEN", "TARGET_SUPABASE_ACCESS_TOKEN"):
        token = parsed[key]
        require(
            20 <= len(token) <= 256
            and not any(character.isspace() or ord(character) < 32 for character in token),
            "Supabase Management API token is invalid",
        )
    return parsed


def validate_manifest(manifest: dict[str, Any]) -> None:
    version = manifest.get("version")
    require(
        isinstance(version, str) and RELEASE_PATTERN.fullmatch(version) is not None,
        "release version is invalid",
    )
    require(manifest.get("image") == f"motorist-app:{version}", "release image mismatch")
    require(
        isinstance(manifest.get("imageId"), str)
        and IMAGE_ID_PATTERN.fullmatch(manifest["imageId"]) is not None,
        "release image ID is invalid",
    )
    require(manifest.get("platform") == "linux/amd64", "release platform mismatch")
    require(manifest.get("schedulerEnabled") is False, "release scheduler is unsafe")
    require(
        isinstance(manifest.get("gitSha"), str)
        and re.fullmatch(r"[0-9a-f]{40}", manifest["gitSha"]) is not None,
        "release git SHA is invalid",
    )
    for key in ("buildContextSha256", "buildArgsSha256"):
        require(
            isinstance(manifest.get(key), str)
            and SHA256_PATTERN.fullmatch(manifest[key]) is not None,
            f"release {key} is invalid",
        )


def validate_release_integrity(
    release_dir_arg: Path,
) -> tuple[Path, dict[str, Any], str, str]:
    release_dir = require_directory(release_dir_arg, private=False)
    require_directory(release_dir / "bin", private=False)
    expected_helper = release_dir / "bin" / "create-activation-gate.py"
    require(
        Path(__file__).resolve() == expected_helper,
        "activation gate helper is outside the selected release",
    )
    manifest, manifest_bytes = read_json(release_dir / "manifest.json", private=False)
    validate_manifest(manifest)
    sums_bytes = read_bytes(release_dir / "SHA256SUMS", private=False)
    try:
        sums_text = sums_bytes.decode("ascii")
    except UnicodeDecodeError as error:
        raise SystemExit("SHA256SUMS is not ASCII") from error
    require(sums_text.endswith("\n"), "SHA256SUMS is incomplete")
    checksums: dict[str, str] = {}
    for line in sums_text.splitlines():
        match = re.fullmatch(r"([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._/-]*)", line)
        require(match is not None, "SHA256SUMS contains an invalid entry")
        expected_sha256, name = match.groups()
        pure_path = PurePosixPath(name)
        require(
            not pure_path.is_absolute()
            and "." not in pure_path.parts
            and ".." not in pure_path.parts,
            "SHA256SUMS path escapes the release",
        )
        require(name not in checksums, "SHA256SUMS contains a duplicate entry")
        checksums[name] = expected_sha256
    require(
        REQUIRED_RELEASE_FILES.issubset(checksums),
        "SHA256SUMS does not cover the required release",
    )
    for name, expected_sha256 in checksums.items():
        require(
            sha256_file(release_dir / Path(*PurePosixPath(name).parts))
            == expected_sha256,
            "release checksum verification failed",
        )
    require(
        hashlib.sha256(manifest_bytes).hexdigest() == checksums["manifest.json"],
        "manifest checksum mismatch",
    )
    return (
        release_dir,
        manifest,
        hashlib.sha256(manifest_bytes).hexdigest(),
        hashlib.sha256(sums_bytes).hexdigest(),
    )


def validate_cutover_receipt(
    path: Path,
    manifest: dict[str, Any],
    sha256sums_sha256: str,
) -> tuple[str, dict[str, Any]]:
    contents = read_bytes(path, private=True)
    require(contents.endswith(b"\n"), "cutover receipt is incomplete")
    lines = contents.splitlines(keepends=True)
    require(len(lines) == 2, "cutover receipt must contain exactly two records")
    records: list[dict[str, Any]] = []
    for line in lines:
        try:
            record = json.loads(line)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise SystemExit("cutover receipt contains invalid JSON") from error
        require(isinstance(record, dict), "cutover receipt record is invalid")
        records.append(record)
    first, terminal = records
    require(
        first.get("receipt_schema_version") == 2
        and terminal.get("receipt_schema_version") == 2,
        "cutover receipt schema mismatch",
    )
    require(first.get("previous_record_sha256") is None, "cutover chain start is invalid")
    require(
        terminal.get("previous_record_sha256")
        == hashlib.sha256(lines[0]).hexdigest(),
        "cutover receipt chain hash mismatch",
    )
    identity_fields = (
        "release_version",
        "image",
        "image_id",
        "build_context_sha256",
        "build_args_sha256",
        "sha256sums_sha256",
        "gate_snapshot_id",
        "gate_run_id",
        "gate_report_sha256",
        "continuity_policy_sha256",
        "continuity_anchor_sha256",
        "live_watermark_anchor_sha256",
        "live_storage_anchor_sha256",
        "live_storage_transition_manifest_sha256",
        "component_report_sha256",
        "gate_validated_at_utc",
    )
    require(
        all(first.get(field) == terminal.get(field) for field in identity_fields),
        "cutover receipt identity changed",
    )
    expected_identity = {
        "release_version": manifest["version"],
        "image": manifest["image"],
        "image_id": manifest["imageId"],
        "build_context_sha256": manifest["buildContextSha256"],
        "build_args_sha256": manifest["buildArgsSha256"],
        "sha256sums_sha256": sha256sums_sha256,
    }
    require(
        all(first.get(field) == value for field, value in expected_identity.items()),
        "cutover receipt release identity mismatch",
    )
    require(
        re.fullmatch(r"\d{8}T\d{6}Z", str(first.get("gate_snapshot_id")))
        is not None,
        "cutover gate snapshot identity is invalid",
    )
    require(
        re.fullmatch(
            r"\d{8}T\d{6}Z-\d+-\d+", str(first.get("gate_run_id"))
        )
        is not None,
        "cutover gate run identity is invalid",
    )
    for field in (
        "gate_report_sha256",
        "continuity_policy_sha256",
        "continuity_anchor_sha256",
        "live_watermark_anchor_sha256",
        "live_storage_anchor_sha256",
        "live_storage_transition_manifest_sha256",
    ):
        require(
            isinstance(first.get(field), str)
            and SHA256_PATTERN.fullmatch(first[field]) is not None,
            "cutover receipt hash identity is invalid",
        )
    component_hashes = first.get("component_report_sha256")
    require(
        isinstance(component_hashes, dict)
        and sorted(component_hashes)
        == ["application", "auth", "config", "database", "storage"]
        and all(
            isinstance(value, str) and SHA256_PATTERN.fullmatch(value) is not None
            for value in component_hashes.values()
        ),
        "cutover component-report identity is invalid",
    )
    parse_utc(first.get("gate_validated_at_utc"), "cutover gate_validated_at_utc")
    require(
        first.get("status") == "in_progress"
        and first.get("stage") == "cutover_started",
        "cutover receipt has no valid initial record",
    )
    require(
        terminal.get("status") == "success"
        and terminal.get("stage") == "cutover_complete",
        "cutover receipt has no successful terminal record",
    )
    require(terminal.get("compose_healthy") is True, "cutover compose is not healthy")
    require(terminal.get("https_healthy") is True, "cutover HTTPS is not healthy")
    require(terminal.get("stack_removed") is False, "cutover stack was removed")
    require(terminal.get("dns_points_to_target") is True, "cutover DNS is invalid")
    require(
        terminal.get("dns_expected_ipv4") == "195.201.36.90",
        "cutover target address is invalid",
    )
    for record in records:
        require(record.get("scheduler_enabled") is False, "cutover started a scheduler")
        require(
            record.get("predeployment_source_write_freeze_active") is True,
            "cutover source freeze evidence is invalid",
        )
        require(
            record.get("predeployment_target_jobs_active") is False,
            "cutover target job evidence is invalid",
        )
    require(
        parse_utc(first.get("recorded_at_utc"), "cutover recorded_at_utc")
        <= parse_utc(terminal.get("recorded_at_utc"), "cutover recorded_at_utc")
        <= dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=5),
        "cutover receipt timestamps are invalid",
    )
    return hashlib.sha256(contents).hexdigest(), first


def validate_combined_gate(
    path: Path,
    receipt: dict[str, Any],
    manifest: dict[str, Any],
    sha256sums_sha256: str,
) -> str:
    gate, contents = read_json(path, private=True)
    gate_sha256 = hashlib.sha256(contents).hexdigest()
    require(
        gate_sha256 == receipt.get("gate_report_sha256"),
        "combined gate checksum differs from cutover receipt",
    )
    require(gate.get("gate_status") == "pass_predeployment", "combined gate did not pass")
    require(gate.get("failures") == [], "combined gate contains failures")
    require(gate.get("source_project_ref") == SOURCE_REF, "combined gate source mismatch")
    require(gate.get("target_project_ref") == TARGET_REF, "combined gate target mismatch")
    require(
        gate.get("snapshot_id") == receipt.get("gate_snapshot_id"),
        "combined gate snapshot binding differs",
    )
    require(
        gate.get("gate_run_id") == receipt.get("gate_run_id"),
        "combined gate run binding differs",
    )

    expected_release_identity = {
        "release_version": manifest["version"],
        "image_id": manifest["imageId"],
        "build_context_sha256": manifest["buildContextSha256"],
        "build_args_sha256": manifest["buildArgsSha256"],
        "sha256sums_sha256": sha256sums_sha256,
    }
    require(
        all(gate.get(field) == value for field, value in expected_release_identity.items()),
        "combined gate release identity differs",
    )
    require(
        all(receipt.get(field) == value for field, value in expected_release_identity.items()),
        "cutover receipt release identity differs from combined gate",
    )

    continuity_fields = (
        "continuity_policy_sha256",
        "continuity_anchor_sha256",
        "live_watermark_anchor_sha256",
        "live_storage_anchor_sha256",
        "live_storage_transition_manifest_sha256",
    )
    for field in continuity_fields:
        value = gate.get(field)
        require(
            isinstance(value, str)
            and SHA256_PATTERN.fullmatch(value) is not None
            and receipt.get(field) == value,
            "combined gate continuity identity differs",
        )

    component_hashes = gate.get("component_report_sha256")
    require(
        isinstance(component_hashes, dict)
        and sorted(component_hashes)
        == ["application", "auth", "config", "database", "storage"]
        and all(
            isinstance(value, str) and SHA256_PATTERN.fullmatch(value) is not None
            for value in component_hashes.values()
        )
        and receipt.get("component_report_sha256") == component_hashes,
        "combined gate component-report identity differs",
    )
    for field in ("auth_redirect_receipt_sha256", "rentals_vercel_env_receipt_sha256"):
        value = gate.get(field)
        require(
            isinstance(value, str) and SHA256_PATTERN.fullmatch(value) is not None,
            "combined gate supporting receipt identity is invalid",
        )

    require(gate.get("source_write_freeze_active") is True, "combined gate source freeze is inactive")
    require(gate.get("source_deleted") is False, "combined gate source deletion state is invalid")
    require(gate.get("target_writable") is True, "combined gate target write state is invalid")
    require(gate.get("target_jobs_active") is False, "combined gate target jobs are active")
    require(gate.get("scheduler_enabled") is False, "combined gate scheduler is active")
    require(
        gate.get("production_cutover_performed") is False,
        "combined gate was already marked as consumed",
    )
    require(gate.get("component_evidence_count") == 6, "combined gate evidence count is invalid")

    gate_started_at = parse_utc(gate.get("gate_started_at_utc"), "combined gate_started_at_utc")
    gate_validated_at = parse_utc(gate.get("validated_at_utc"), "combined gate validated_at_utc")
    gate_completed_at = parse_utc(gate.get("completed_at_utc"), "combined gate completed_at_utc")
    operational_validated_at = parse_utc(
        gate.get("operational_state_validated_at_utc"),
        "combined gate operational_state_validated_at_utc",
    )
    receipt_gate_validated_at = parse_utc(
        receipt.get("gate_validated_at_utc"),
        "cutover gate_validated_at_utc",
    )
    cutover_started_at = parse_utc(receipt.get("recorded_at_utc"), "cutover recorded_at_utc")
    require(
        gate_validated_at == receipt_gate_validated_at,
        "combined gate validation timestamp differs from cutover receipt",
    )
    require(
        gate_started_at <= gate_validated_at <= gate_completed_at <= cutover_started_at,
        "combined gate and cutover timestamps are out of order",
    )
    require(
        gate_started_at <= operational_validated_at <= gate_completed_at,
        "combined gate operational timestamp is out of order",
    )
    gate_run_duration = gate.get("gate_run_duration_seconds")
    maximum_component_age = gate.get("maximum_component_age_seconds")
    require(type(gate_run_duration) is int, "combined gate run duration is invalid")
    require(type(maximum_component_age) is int, "combined gate component age is invalid")
    require(
        gate_run_duration == int((gate_completed_at - gate_started_at).total_seconds())
        and 0 <= gate_run_duration <= 30 * 60,
        "combined gate run duration differs from its timestamps",
    )
    require(
        maximum_component_age == int((gate_completed_at - gate_validated_at).total_seconds())
        and 0 <= maximum_component_age <= 30 * 60,
        "combined gate component age differs from its timestamps",
    )
    require(
        0
        <= (cutover_started_at - gate_validated_at).total_seconds()
        <= MAX_PREDEPLOYMENT_GATE_TO_CUTOVER_SECONDS,
        "combined gate was stale when cutover started",
    )
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        return None


def read_limited_response(response: Any, maximum_bytes: int) -> bytes:
    payload = response.read(maximum_bytes + 1)
    require(len(payload) <= maximum_bytes, "remote response is too large")
    return payload


def fetch_project_state_row(project_ref: str, token: str) -> dict[str, Any]:
    require(project_ref in (SOURCE_REF, TARGET_REF), "project ref is not allowed")
    query = SOURCE_STATE_QUERY if project_ref == SOURCE_REF else TARGET_STATE_QUERY
    body = json.dumps({"query": query, "read_only": True}).encode("utf-8")
    request = urllib.request.Request(
        f"{MANAGEMENT_ORIGIN}/v1/projects/{project_ref}/database/query",
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
    )
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=20) as response:
            require(response.status == 200, "Supabase Management API query failed")
            payload = read_limited_response(response, MAX_API_RESPONSE_BYTES)
    except (OSError, urllib.error.URLError, urllib.error.HTTPError) as error:
        raise SystemExit("Supabase Management API query failed") from error
    try:
        rows = json.loads(payload)
    except json.JSONDecodeError as error:
        raise SystemExit("Supabase Management API returned invalid JSON") from error
    require(
        isinstance(rows, list) and len(rows) == 1 and isinstance(rows[0], dict),
        "Supabase Management API returned invalid aggregate state",
    )
    return rows[0]


def validate_project_state(project_ref: str, row: dict[str, Any]) -> dict[str, Any]:
    require(project_ref in (SOURCE_REF, TARGET_REF), "project ref is not allowed")
    require(
        type(row.get("database_default_read_only")) is bool,
        "database freeze state is invalid",
    )
    require(type(row.get("active_cron_jobs")) is int, "cron count is invalid")
    if project_ref == SOURCE_REF:
        require(row["database_default_read_only"] is True, "source freeze is inactive")
        require(row["active_cron_jobs"] == 0, "source has active cron jobs")
        return {
            "persistentDatabaseFreeze": True,
            "activeCronJobs": 0,
        }
    for key in (
        "job_controls_total",
        "job_controls_enabled",
        "expected_job_controls_total",
    ):
        require(type(row.get(key)) is int, "target job-control aggregate is invalid")
    require(
        row["database_default_read_only"] is False,
        "target has a persistent read-only default",
    )
    require(row["active_cron_jobs"] == 0, "target has active cron jobs")
    require(
        row["job_controls_total"] == len(EXPECTED_JOB_CONTROLS)
        and row["expected_job_controls_total"] == len(EXPECTED_JOB_CONTROLS),
        "target job-control set is not exact",
    )
    require(row["job_controls_enabled"] == 0, "target has enabled job controls")
    return {
        "persistentDatabaseFreeze": False,
        "activeCronJobs": 0,
        "jobControlsTotal": len(EXPECTED_JOB_CONTROLS),
        "jobControlsEnabled": 0,
        "jobControlSetExact": True,
    }


def validate_public_https(release_version: str) -> dict[str, bool]:
    opener = urllib.request.build_opener(NoRedirect())
    for endpoint, expected_status in (("live", "live"), ("ready", "ready")):
        url = f"{PUBLIC_ORIGIN}/api/health/{endpoint}"
        request = urllib.request.Request(
            url,
            method="GET",
            headers={"Accept": "application/json", "Cache-Control": "no-cache"},
        )
        try:
            with opener.open(request, timeout=15) as response:
                require(response.status == 200, "production HTTPS health check failed")
                require(response.geturl() == url, "production HTTPS health check redirected")
                payload = read_limited_response(response, MAX_HEALTH_RESPONSE_BYTES)
        except (OSError, urllib.error.URLError, urllib.error.HTTPError) as error:
            raise SystemExit("production HTTPS health check failed") from error
        try:
            health = json.loads(payload)
        except json.JSONDecodeError as error:
            raise SystemExit("production HTTPS health response is invalid") from error
        require(isinstance(health, dict), "production HTTPS health response is invalid")
        require(
            health.get("status") == expected_status,
            "production HTTPS health status mismatch",
        )
        require(
            health.get("version") == release_version,
            "production HTTPS release mismatch",
        )
    return {"live": True, "ready": True, "exactRelease": True}


def run_dig(arguments: list[str]) -> str:
    require(shutil.which("dig") is not None, "dig is required for DNS validation")
    try:
        result = subprocess.run(
            ["dig", "+time=5", "+tries=2", *arguments],
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise SystemExit("authoritative DNS validation failed") from error
    require(result.returncode == 0, "authoritative DNS validation failed")
    return result.stdout


def validate_authoritative_dns() -> dict[str, Any]:
    domain = "dispecing.linkapomoci.sk"
    zone = "linkapomoci.sk"
    expected_ipv4 = "195.201.36.90"
    nameservers = sorted(
        {
            line.strip().rstrip(".")
            for line in run_dig(["+short", "NS", zone]).splitlines()
            if line.strip()
        }
    )
    require(nameservers, "no authoritative nameservers were discovered")
    require(len(nameservers) <= 20, "authoritative nameserver set is invalid")
    for nameserver in nameservers:
        require(
            re.fullmatch(r"[A-Za-z0-9.-]{1,253}", nameserver) is not None,
            "authoritative nameserver identity is invalid",
        )
        response = run_dig(
            ["+noall", "+comments", "+answer", "A", domain, f"@{nameserver}"]
        )
        comment_lines = [line for line in response.splitlines() if line.startswith(";;")]
        require(
            any(
                " flags:" in line
                and "aa" in line.split(" flags:", 1)[1].split(";", 1)[0].split()
                for line in comment_lines
            ),
            "DNS response was not authoritative",
        )
        addresses: set[str] = set()
        for line in response.splitlines():
            if not line or line.startswith(";;"):
                continue
            fields = line.split()
            require(len(fields) >= 5, "authoritative DNS answer is invalid")
            require(fields[3] != "CNAME", "production DNS uses a CNAME")
            if fields[3] == "A":
                addresses.add(fields[4])
        require(
            addresses == {expected_ipv4},
            "authoritative DNS does not point exclusively to the target",
        )
    recursive_addresses = {
        line.strip()
        for line in run_dig(["+short", "A", domain]).splitlines()
        if line.strip()
    }
    require(
        recursive_addresses == {expected_ipv4},
        "recursive DNS does not point exclusively to the target",
    )
    return {
        "authoritativeExactTarget": True,
        "recursiveExactTarget": True,
        "authoritativeNameserverCount": len(nameservers),
    }


def write_private_exclusive(path: Path, payload: bytes) -> None:
    parent = require_directory(path.parent, private=True)
    output = parent / path.name
    require(output.name not in ("", ".", ".."), "activation gate path is invalid")
    require(not output.exists() and not output.is_symlink(), "activation gate already exists")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(output, flags, 0o600)
    opened = os.fstat(descriptor)
    try:
        require(
            stat.S_ISREG(opened.st_mode)
            and stat.S_IMODE(opened.st_mode) == 0o600
            and opened.st_nlink == 1,
            "activation gate output is unsafe",
        )
        offset = 0
        while offset < len(payload):
            offset += os.write(descriptor, payload[offset:])
        os.fsync(descriptor)
    except BaseException:
        os.close(descriptor)
        try:
            current = os.lstat(output)
            if (current.st_dev, current.st_ino) == (opened.st_dev, opened.st_ino):
                os.unlink(output)
        except FileNotFoundError:
            pass
        raise
    else:
        os.close(descriptor)
    directory_descriptor = os.open(parent, os.O_RDONLY)
    try:
        os.fsync(directory_descriptor)
    finally:
        os.close(directory_descriptor)


QueryFunction = Callable[[str, str], dict[str, Any]]
HealthFunction = Callable[[str], dict[str, bool]]
DnsFunction = Callable[[], dict[str, Any]]


def create_activation_gate(
    release_dir_arg: Path,
    cutover_receipt_path: Path,
    migration_env_path: Path,
    output_path: Path,
    *,
    query_function: QueryFunction = fetch_project_state_row,
    health_function: HealthFunction = validate_public_https,
    dns_function: DnsFunction = validate_authoritative_dns,
) -> None:
    validation_started_monotonic = time.monotonic()
    validation_started_at = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    (
        _release_dir,
        manifest,
        manifest_sha256,
        sha256sums_sha256,
    ) = validate_release_integrity(release_dir_arg)
    cutover_receipt_sha256, cutover_receipt = validate_cutover_receipt(
        cutover_receipt_path, manifest, sha256sums_sha256
    )
    cutover_receipt_path = safe_absolute_path(cutover_receipt_path)
    require(
        cutover_receipt_path.name == f"cutover-{manifest['version']}.jsonl",
        "cutover receipt filename does not match the selected release",
    )
    combined_gate_path = cutover_receipt_path.with_name(
        f"cutover-{manifest['version']}.combined-gate.json"
    )
    validate_combined_gate(
        combined_gate_path,
        cutover_receipt,
        manifest,
        sha256sums_sha256,
    )
    migration_env = parse_env(migration_env_path)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as executor:
        source_future = executor.submit(
            query_function,
            SOURCE_REF,
            migration_env["SOURCE_SUPABASE_ACCESS_TOKEN"],
        )
        target_future = executor.submit(
            query_function,
            TARGET_REF,
            migration_env["TARGET_SUPABASE_ACCESS_TOKEN"],
        )
        health_future = executor.submit(health_function, manifest["version"])
        dns_future = executor.submit(dns_function)
        source_state = validate_project_state(SOURCE_REF, source_future.result())
        target_state = validate_project_state(TARGET_REF, target_future.result())
        public_https = health_future.result()
        dns_state = dns_future.result()

    validation_completed_at = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    validation_duration_seconds = int(
        (validation_completed_at - validation_started_at).total_seconds()
    )
    require(
        time.monotonic() - validation_started_monotonic
        <= MAX_VALIDATION_DURATION_SECONDS,
        "activation gate validation exceeded 120 seconds",
    )
    require(
        0 <= validation_duration_seconds <= MAX_VALIDATION_DURATION_SECONDS,
        "activation gate timing is invalid",
    )

    gate = {
        "schema": "motorist-activation-gate/v1",
        "gateStatus": "pass_activation",
        "sourceProjectRef": SOURCE_REF,
        "targetProjectRef": TARGET_REF,
        "source": source_state,
        "target": target_state,
        "publicHttps": public_https,
        "dns": dns_state,
        "cutoverReceiptSha256": cutover_receipt_sha256,
        "releaseVersion": manifest["version"],
        "gitSha": manifest["gitSha"],
        "image": manifest["image"],
        "imageId": manifest["imageId"],
        "platform": manifest["platform"],
        "buildContextSha256": manifest["buildContextSha256"],
        "buildArgsSha256": manifest["buildArgsSha256"],
        "releaseManifestSha256": manifest_sha256,
        "sha256sumsSha256": sha256sums_sha256,
        "validationStartedAtUtc": format_utc(validation_started_at),
        "validationCompletedAtUtc": format_utc(validation_completed_at),
        "validationDurationSeconds": validation_duration_seconds,
        "maximumAgeSeconds": MAX_GATE_AGE_SECONDS,
        "validUntilUtc": format_utc(
            validation_completed_at + dt.timedelta(seconds=MAX_GATE_AGE_SECONDS)
        ),
        "validatedAtUtc": format_utc(validation_completed_at),
    }
    payload = (json.dumps(gate, separators=(",", ":"), ensure_ascii=True) + "\n").encode(
        "utf-8"
    )
    write_private_exclusive(output_path, payload)


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Create a read-only post-cutover activation gate."
    )
    parser.add_argument("release_dir")
    parser.add_argument("cutover_receipt")
    parser.add_argument("migration_env")
    parser.add_argument("output_gate")
    return parser.parse_args()


def main() -> None:
    os.umask(0o077)
    arguments = parse_arguments()
    create_activation_gate(
        Path(arguments.release_dir),
        Path(arguments.cutover_receipt),
        Path(arguments.migration_env),
        Path(arguments.output_gate),
    )


if __name__ == "__main__":
    main()
