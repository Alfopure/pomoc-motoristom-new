#!/usr/bin/env python3

"""Fail-closed validation and narrowly scoped activation helpers.

The command deliberately never prints runtime values, REST response bodies, or
file hashes.  Its only stdout is the non-sensitive release identity emitted by
``preflight``.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


SOURCE_REF = "jcwbiulwuwyrnmzjjbgr"
TARGET_REF = "sjcsrygkkmersoczpunh"
TARGET_URL = f"https://{TARGET_REF}.supabase.co"
MAX_GATE_AGE_SECONDS = 5 * 60
MAX_ONE_SHOT_AGE_SECONDS = 24 * 60 * 60
MAX_INPUT_BYTES = 1024 * 1024
RELEASE_PATTERN = re.compile(r"hetzner-[A-Za-z0-9][A-Za-z0-9._-]{0,95}")
IMAGE_ID_PATTERN = re.compile(r"sha256:[0-9a-f]{64}")
ENV_KEY_PATTERN = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
PHONE_LIKE_PATTERN = re.compile(r"\+?\d[\d\s()\-]{7,}\d")

ALL_JOBS = (
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
RELEASE_CHECKSUM_FILES = (
    "image.tar.gz",
    "manifest.json",
    "compose.yml",
    "Caddyfile",
    "upstream.caddy",
    "runtime-env-parser.mjs",
    "bin/install-release.sh",
    "bin/validate-gate-timestamp.py",
    "bin/write-cutover-receipt.py",
    "bin/capture-private-evidence.py",
    "bin/open-operation-lock.py",
    "bin/run-one-shot-job.sh",
    "bin/write-one-shot-receipt.py",
    "bin/activate-after-cutover.sh",
    "bin/activate-telephony-background.sh",
    "bin/activate-viptel-listener-only.sh",
    "bin/handover-viptel-listener-only.sh",
    "bin/upgrade-viptel-listener-only.sh",
    "bin/stage-viptel-listener-handover.sh",
    "bin/prepare-runtime-env.mjs",
    "bin/runtime-env-contract.mjs",
    "bin/validate-activation-inputs.py",
    "bin/create-activation-gate.py",
    "bin/probe-viptel-listener.sh",
    "bin/write-viptel-listener-receipt.py",
)
ACTIVATABLE_JOBS = frozenset(ALL_JOBS) - {
    "fleet.swhouse.occupancy",
    "fleet.swhouse.roster",
}
ONE_SHOT_NUMERIC_FIELDS = {
    "fleet.webdispecink.positions": ("positionCount", "updatedAssetPositions", "unmappedPositionCount"),
    "fleet.webdispecink.catalog": ("catalogCount", "providerVehicleCount", "linkedVehicleCount"),
    "fleet.commander.positions": ("fetchedCount", "updatedCount", "skippedCount", "errorCount"),
    "fleet.commander.catalog": ("fetchedCount", "createdCount", "updatedCount", "errorCount"),
    "notifications.materialize": ("processed", "sent", "cancelled", "failed"),
    "telephony.recordings.sync": ("cdrWithRecording", "discovered", "processed", "failed", "pendingLeft"),
    "telephony.transcripts.process": ("candidates", "processed", "failed", "skipped", "aiProcessed", "aiFailed"),
    "telephony.viptel.reconcile": ("activeFetched", "activeUpserts", "cdrFetched", "cdrUpserts"),
    "infra.hetzner.audit": ("servers", "primaryIps", "volumes", "floatingIps", "loadBalancers", "backups"),
}
ONE_SHOT_STATUS_FIELDS = {
    "fleet.webdispecink.positions": {"mode": "positions"},
    "fleet.webdispecink.catalog": {"mode": "catalog"},
    "fleet.commander.positions": {"status": "success"},
    "fleet.commander.catalog": {"status": "success"},
    "telephony.recordings.sync": {"status": "ok"},
    "telephony.transcripts.process": {"status": "ok"},
}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def parse_utc(value: object, field: str) -> dt.datetime:
    require(isinstance(value, str), f"{field} is not a UTC timestamp")
    require(
        re.fullmatch(
            r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)",
            value,
        )
        is not None,
        f"{field} is not a strict UTC timestamp",
    )
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        require(parsed.utcoffset() == dt.timedelta(0), f"{field} is not UTC")
        return parsed.astimezone(dt.timezone.utc)
    except ValueError as error:
        raise SystemExit(f"{field} is invalid") from error


def require_safe_directory(path: Path, private: bool = False) -> Path:
    absolute = Path(os.path.abspath(path))
    metadata = os.lstat(absolute)
    require(stat.S_ISDIR(metadata.st_mode), f"{absolute} is not a directory")
    require(not stat.S_ISLNK(metadata.st_mode), f"{absolute} must not be a symlink")
    require(Path(os.path.realpath(absolute)) == absolute, f"{absolute} traverses a symlink")
    if private:
        require(
            stat.S_IMODE(metadata.st_mode) & 0o077 == 0,
            f"{absolute} must be private",
        )
    return absolute


def require_regular_file(
    path: Path,
    *,
    private: bool,
    maximum_size: int | None = MAX_INPUT_BYTES,
) -> os.stat_result:
    metadata = os.lstat(path)
    require(stat.S_ISREG(metadata.st_mode), f"{path} is not a regular file")
    require(not stat.S_ISLNK(metadata.st_mode), f"{path} must not be a symlink")
    require(metadata.st_nlink == 1, f"{path} must have exactly one link")
    if maximum_size is not None:
        require(metadata.st_size <= maximum_size, f"{path} is too large")
    if private:
        require(
            stat.S_IMODE(metadata.st_mode) & 0o077 == 0,
            f"{path} must be mode 0600 or stricter",
        )
    return metadata


def read_bytes(path: Path, *, private: bool) -> bytes:
    before = require_regular_file(path, private=private)
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        opened = os.fstat(descriptor)
        require(
            (opened.st_dev, opened.st_ino, opened.st_size)
            == (before.st_dev, before.st_ino, before.st_size),
            f"{path} changed during validation",
        )
        chunks: list[bytes] = []
        remaining = MAX_INPUT_BYTES + 1
        while remaining:
            chunk = os.read(descriptor, min(65536, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        payload = b"".join(chunks)
        require(len(payload) <= MAX_INPUT_BYTES, f"{path} is too large")
        after = os.fstat(descriptor)
        require(
            (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
            == (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns),
            f"{path} changed during validation",
        )
        return payload
    finally:
        os.close(descriptor)


def read_json(path: Path, *, private: bool) -> dict[str, Any]:
    try:
        value = json.loads(read_bytes(path, private=private))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SystemExit(f"{path} is not valid JSON") from error
    require(isinstance(value, dict), f"{path} must contain a JSON object")
    return value


def parse_env(path: Path) -> tuple[dict[str, str], list[str]]:
    try:
        contents = read_bytes(path, private=True).decode("utf-8")
    except UnicodeDecodeError as error:
        raise SystemExit(f"{path} is not UTF-8") from error
    require(contents.endswith("\n"), f"{path} is incomplete")
    parsed: dict[str, str] = {}
    order: list[str] = []
    for line_number, line in enumerate(contents.splitlines(), 1):
        if not line:
            continue
        require("=" in line, f"{path}:{line_number} is not KEY=value")
        key, encoded = line.split("=", 1)
        require(
            ENV_KEY_PATTERN.fullmatch(key) is not None,
            f"{path}:{line_number} has an invalid key",
        )
        require(key not in parsed, f"{path} contains a duplicate key")
        try:
            value = json.loads(encoded)
        except json.JSONDecodeError as error:
            raise SystemExit(f"{path}:{line_number} is not JSON-quoted") from error
        require(isinstance(value, str), f"{path}:{line_number} is not a string")
        require("\0" not in value, f"{path}:{line_number} contains a null byte")
        parsed[key] = value
        order.append(key)
    return parsed, order


def load_manifest(production_dir: Path) -> dict[str, Any]:
    manifest = read_json(production_dir / "manifest.json", private=False)
    version = manifest.get("version")
    require(
        isinstance(version, str) and RELEASE_PATTERN.fullmatch(version) is not None,
        "release version is invalid",
    )
    require(manifest.get("image") == f"motorist-app:{version}", "release image mismatch")
    require(
        isinstance(manifest.get("gitSha"), str)
        and re.fullmatch(r"[0-9a-f]{40}", manifest["gitSha"]) is not None,
        "release git SHA is invalid",
    )
    require(
        isinstance(manifest.get("imageId"), str)
        and IMAGE_ID_PATTERN.fullmatch(manifest["imageId"]) is not None,
        "release image ID is invalid",
    )
    require(manifest.get("platform") == "linux/amd64", "release platform mismatch")
    require(manifest.get("schedulerEnabled") is False, "release scheduler contract is unsafe")
    for key in ("buildContextSha256", "buildArgsSha256"):
        require(
            isinstance(manifest.get(key), str)
            and re.fullmatch(r"[0-9a-f]{64}", manifest[key]) is not None,
            f"release {key} is invalid",
        )
    return manifest


def validate_release_integrity(production_dir: Path) -> str:
    bin_dir = require_safe_directory(production_dir / "bin")
    for name in RELEASE_CHECKSUM_FILES:
        metadata = require_regular_file(
            production_dir / name,
            private=False,
            maximum_size=None,
        )
        if name.startswith("bin/"):
            require(metadata.st_mode & 0o111 != 0, f"release helper {name} is not executable")

    sums_path = production_dir / "SHA256SUMS"
    try:
        contents = read_bytes(sums_path, private=False)
        text = contents.decode("ascii")
    except UnicodeDecodeError as error:
        raise SystemExit("release checksum manifest is not ASCII") from error
    require(text.endswith("\n"), "release checksum manifest is incomplete")
    names: list[str] = []
    for line in text.splitlines():
        match = re.fullmatch(r"[0-9a-f]{64}  ([A-Za-z0-9][A-Za-z0-9._/-]*)", line)
        require(match is not None, "release checksum manifest has an invalid entry")
        name = match.group(1)
        require(".." not in Path(name).parts, "release checksum path escapes the release")
        require(name not in names, "release checksum manifest contains duplicates")
        names.append(name)
    require(
        set(names) == set(RELEASE_CHECKSUM_FILES) and len(names) == len(RELEASE_CHECKSUM_FILES),
        "release checksum manifest does not cover the exact release",
    )
    try:
        result = subprocess.run(
            ["sha256sum", "-c", "SHA256SUMS"],
            cwd=production_dir,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=600,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise SystemExit("release checksum verification could not complete") from error
    require(result.returncode == 0, "release checksum verification failed")
    require(bin_dir == production_dir / "bin", "release bin directory mismatch")
    return hashlib.sha256(contents).hexdigest()


def verify_listener_release(args: argparse.Namespace) -> None:
    production_dir = require_safe_directory(Path(args.production_dir))
    manifest = load_manifest(production_dir)
    require(manifest["version"] == args.release_version, "listener release version mismatch")
    require(manifest["gitSha"] == args.expected_git_sha, "listener release Git SHA mismatch")
    release_sha256 = validate_release_integrity(production_dir)
    if args.expected_release_sha256 is not None:
        require(
            re.fullmatch(r"[0-9a-f]{64}", args.expected_release_sha256) is not None,
            "expected release checksum binding is invalid",
        )
        require(
            release_sha256 == args.expected_release_sha256,
            "listener release checksum binding changed",
        )


def validate_historic_release_integrity(production_dir: Path) -> str:
    """Validate an installed historic release without assuming today's file list.

    Handover never executes a helper from the historic release. Its immutable
    inventory is therefore the exact set of regular files outside ``env`` and
    ``SHA256SUMS``, and every one of those files must be checksum-bound.
    """
    sums_path = production_dir / "SHA256SUMS"
    try:
        contents = read_bytes(sums_path, private=False)
        text = contents.decode("ascii")
    except UnicodeDecodeError as error:
        raise SystemExit("historic release checksum manifest is not ASCII") from error
    require(text.endswith("\n"), "historic release checksum manifest is incomplete")
    names: list[str] = []
    for line in text.splitlines():
        match = re.fullmatch(r"[0-9a-f]{64}  ([A-Za-z0-9][A-Za-z0-9._/-]*)", line)
        require(match is not None, "historic release checksum manifest has an invalid entry")
        name = match.group(1)
        require(".." not in Path(name).parts, "historic release checksum path escapes the release")
        require(name not in names, "historic release checksum manifest contains duplicates")
        names.append(name)
    required = {"image.tar.gz", "manifest.json", "compose.yml", "Caddyfile", "upstream.caddy"}
    require(required <= set(names), "historic release checksum manifest is missing a required file")

    immutable_files: set[str] = set()
    entry_count = 0
    for root, directory_names, file_names in os.walk(production_dir, followlinks=False):
        root_path = Path(root)
        relative_root = root_path.relative_to(production_dir)
        retained_directories: list[str] = []
        for directory_name in directory_names:
            entry_count += 1
            require(entry_count <= 500, "historic release contains too many entries")
            path = root_path / directory_name
            metadata = os.lstat(path)
            require(stat.S_ISDIR(metadata.st_mode), "historic release contains an unsafe directory entry")
            relative = path.relative_to(production_dir)
            if relative.parts == ("env",):
                continue
            retained_directories.append(directory_name)
        directory_names[:] = retained_directories
        for file_name in file_names:
            entry_count += 1
            require(entry_count <= 500, "historic release contains too many entries")
            path = root_path / file_name
            relative = path.relative_to(production_dir).as_posix()
            metadata = os.lstat(path)
            require(stat.S_ISREG(metadata.st_mode), "historic release contains an unsafe file entry")
            require(metadata.st_nlink == 1, "historic release contains a hardlinked file")
            if relative != "SHA256SUMS":
                immutable_files.add(relative)
        require(relative_root.parts != ("env",), "historic runtime directory was traversed")
    require(
        set(names) == immutable_files and len(names) == len(immutable_files),
        "historic checksum manifest does not cover the exact immutable release",
    )
    try:
        result = subprocess.run(
            ["sha256sum", "-c", "SHA256SUMS"],
            cwd=production_dir,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=600,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise SystemExit("historic release checksum verification could not complete") from error
    require(result.returncode == 0, "historic release checksum verification failed")
    return hashlib.sha256(contents).hexdigest()


def verify_handover_release(args: argparse.Namespace) -> None:
    production_dir = require_safe_directory(Path(args.production_dir))
    manifest = load_manifest(production_dir)
    require(manifest["version"] == args.release_version, "handover release version mismatch")
    require(manifest["gitSha"] == args.expected_git_sha, "handover release Git SHA mismatch")
    require(
        re.fullmatch(r"[0-9a-f]{64}", args.expected_release_sha256) is not None,
        "expected historic release checksum binding is invalid",
    )
    require(
        validate_historic_release_integrity(production_dir) == args.expected_release_sha256,
        "historic release checksum binding changed",
    )


def validate_shared_env(env: dict[str, str], version: str) -> None:
    require(env.get("SUPABASE_PROJECT_REF") == TARGET_REF, "runtime target ref mismatch")
    require(env.get("SUPABASE_URL") == TARGET_URL, "runtime target URL mismatch")
    require(
        env.get("NEXT_PUBLIC_SUPABASE_URL") == TARGET_URL,
        "runtime public target URL mismatch",
    )
    require(env.get("DEPLOYMENT_VERSION") == version, "runtime release mismatch")
    require(env.get("NODE_ENV") == "production", "runtime NODE_ENV mismatch")
    require(env.get("MOTORIST_DEV_AUTH_BYPASS") == "false", "runtime auth bypass is unsafe")
    require(
        env.get("APP_BASE_URL") == "https://dispecing.linkapomoci.sk"
        and env.get("PUBLIC_APP_URL") == "https://dispecing.linkapomoci.sk"
        and env.get("NEXT_PUBLIC_APP_URL") == "https://dispecing.linkapomoci.sk",
        "runtime application URL mismatch",
    )
    require(
        all(SOURCE_REF not in value for value in env.values()),
        "source project ref is present in runtime",
    )
    public_keys = (
        "NEXT_PUBLIC_SUPABASE_ANON_KEY",
        "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
        "SUPABASE_ANON_KEY",
        "SUPABASE_PUBLISHABLE_KEY",
    )
    service_keys = ("SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY")
    require(all(env.get(key) for key in public_keys), "runtime public key alias is missing")
    require(all(env.get(key) for key in service_keys), "runtime service key alias is missing")
    require(len({env[key] for key in public_keys}) == 1, "runtime public key aliases differ")
    require(len({env[key] for key in service_keys}) == 1, "runtime service key aliases differ")
    require(env[public_keys[0]] != env[service_keys[0]], "runtime key roles are not separated")


def validate_healthchecks_url(value: object, field: str) -> str:
    require(isinstance(value, str) and value, f"{field} is missing")
    parsed = urllib.parse.urlsplit(value)
    require(
        parsed.scheme == "https"
        and parsed.hostname == "hc-ping.com"
        and parsed.username is None
        and parsed.password is None
        and parsed.port is None
        and parsed.query == ""
        and parsed.fragment == ""
        and re.fullmatch(r"/[0-9a-fA-F-]{32,64}", parsed.path) is not None,
        f"{field} is invalid",
    )
    return value


def load_runtime(
    production_dir: Path,
    version: str,
    *,
    require_initially_disabled: bool,
) -> tuple[dict[str, str], list[str], dict[str, str], list[str]]:
    require_safe_directory(production_dir / "env")
    worker_path = production_dir / "env" / "worker.env"
    listener_path = production_dir / "env" / "viptel-listener.env"
    worker, worker_order = parse_env(worker_path)
    listener, listener_order = parse_env(listener_path)
    validate_shared_env(worker, version)
    validate_shared_env(listener, version)
    require(worker.get("WORKER_INSTANCE_ID") == "motorist-prod-01", "worker identity mismatch")
    require(
        listener.get("VIPTEL_LISTENER_INSTANCE_ID") == "motorist-prod-01-viptel",
        "VIPTel listener identity mismatch",
    )
    validate_healthchecks_url(worker.get("HEALTHCHECKS_PING_URL"), "worker Healthchecks URL")
    validate_healthchecks_url(
        listener.get("VIPTEL_HEALTHCHECKS_PING_URL"),
        "VIPTel Healthchecks URL",
    )
    if require_initially_disabled:
        require(worker.get("SCHEDULER_ENABLED") == "false", "scheduler is already enabled")
        require(
            listener.get("VIPTEL_LISTENER_ENABLED") == "false",
            "VIPTel listener is already enabled",
        )
    else:
        require(
            worker.get("SCHEDULER_ENABLED") in ("true", "false"),
            "scheduler flag is invalid",
        )
        require(
            listener.get("VIPTEL_LISTENER_ENABLED") in ("true", "false"),
            "VIPTel listener flag is invalid",
        )
    return worker, worker_order, listener, listener_order


def parse_jobs(csv: str, *, allow_empty: bool = False) -> list[str]:
    require(isinstance(csv, str), "job list is invalid")
    if not csv:
        require(allow_empty, "at least one job is required")
        return []
    jobs = csv.split(",")
    require(all(job and job == job.strip() for job in jobs), "job list is malformed")
    require(len(jobs) == len(set(jobs)), "job list contains duplicates")
    require(
        all(job in ACTIVATABLE_JOBS for job in jobs),
        "job list contains a denied or unknown job",
    )
    return jobs


def validate_cutover_receipt(path: Path, manifest: dict[str, Any]) -> tuple[str, str]:
    contents = read_bytes(path, private=True)
    require(contents.endswith(b"\n"), "cutover receipt is incomplete")
    lines = contents.splitlines(keepends=True)
    require(len(lines) == 2, "cutover receipt must have exactly two records")
    records: list[dict[str, Any]] = []
    for line in lines:
        try:
            record = json.loads(line)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise SystemExit("cutover receipt chain contains invalid JSON") from error
        require(isinstance(record, dict), "cutover receipt record is invalid")
        records.append(record)
    first, terminal = records
    require(first.get("receipt_schema_version") == 2, "cutover receipt schema mismatch")
    require(terminal.get("receipt_schema_version") == 2, "cutover receipt schema mismatch")
    require(first.get("previous_record_sha256") is None, "cutover chain does not start cleanly")
    require(
        terminal.get("previous_record_sha256") == hashlib.sha256(lines[0]).hexdigest(),
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
        all(first.get(key) == terminal.get(key) for key in identity_fields),
        "cutover receipt identity changed",
    )
    gate_report_sha256 = first.get("gate_report_sha256")
    require(
        isinstance(gate_report_sha256, str)
        and re.fullmatch(r"[0-9a-f]{64}", gate_report_sha256) is not None,
        "cutover gate binding is invalid",
    )
    for field in (
        "continuity_policy_sha256",
        "continuity_anchor_sha256",
        "live_watermark_anchor_sha256",
        "live_storage_anchor_sha256",
        "live_storage_transition_manifest_sha256",
    ):
        value = first.get(field)
        require(
            isinstance(value, str)
            and re.fullmatch(r"[0-9a-f]{64}", value) is not None,
            "cutover continuity binding is invalid",
        )
    component_report_sha256 = first.get("component_report_sha256")
    require(
        isinstance(component_report_sha256, dict)
        and sorted(component_report_sha256)
        == ["application", "auth", "config", "database", "storage"]
        and all(
            isinstance(value, str)
            and re.fullmatch(r"[0-9a-f]{64}", value) is not None
            for value in component_report_sha256.values()
        ),
        "cutover component-report binding is invalid",
    )
    parse_utc(first.get("gate_validated_at_utc"), "cutover gate_validated_at_utc")
    require(first.get("release_version") == manifest["version"], "cutover release mismatch")
    require(first.get("image") == manifest["image"], "cutover image mismatch")
    require(first.get("image_id") == manifest["imageId"], "cutover image ID mismatch")
    require(
        first.get("build_context_sha256") == manifest["buildContextSha256"],
        "cutover build context binding mismatch",
    )
    require(
        first.get("build_args_sha256") == manifest["buildArgsSha256"],
        "cutover build argument binding mismatch",
    )
    sha256sums_sha256 = first.get("sha256sums_sha256")
    require(
        isinstance(sha256sums_sha256, str)
        and re.fullmatch(r"[0-9a-f]{64}", sha256sums_sha256) is not None,
        "cutover release checksum binding is invalid",
    )
    require(
        first.get("status") == "in_progress" and first.get("stage") == "cutover_started",
        "cutover receipt has no valid initial record",
    )
    require(
        terminal.get("status") == "success" and terminal.get("stage") == "cutover_complete",
        "cutover receipt has no successful terminal record",
    )
    require(terminal.get("compose_healthy") is True, "cutover compose was not healthy")
    require(terminal.get("https_healthy") is True, "cutover HTTPS was not healthy")
    require(terminal.get("stack_removed") is False, "cutover stack was removed")
    require(terminal.get("dns_points_to_target") is True, "cutover DNS was not validated")
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
        <= parse_utc(terminal.get("recorded_at_utc"), "cutover recorded_at_utc"),
        "cutover receipt timestamps are out of order",
    )
    return gate_report_sha256, sha256sums_sha256


def validate_activation_gate(
    path: Path,
    manifest: dict[str, Any],
    cutover_receipt_sha256: str,
    release_manifest_sha256: str,
    sha256sums_sha256: str,
    expected_sha256: str | None = None,
) -> str:
    gate_bytes = read_bytes(path, private=True)
    gate_sha256 = hashlib.sha256(gate_bytes).hexdigest()
    if expected_sha256 is not None:
        require(
            re.fullmatch(r"[0-9a-f]{64}", expected_sha256) is not None,
            "expected activation gate checksum is invalid",
        )
        require(
            gate_sha256 == expected_sha256,
            "activation gate changed after preflight",
        )
    try:
        gate = json.loads(gate_bytes)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SystemExit(f"{path} is not valid JSON") from error
    require(isinstance(gate, dict), f"{path} must contain a JSON object")
    expected_keys = {
        "schema",
        "gateStatus",
        "sourceProjectRef",
        "targetProjectRef",
        "source",
        "target",
        "publicHttps",
        "dns",
        "cutoverReceiptSha256",
        "releaseVersion",
        "gitSha",
        "image",
        "imageId",
        "platform",
        "buildContextSha256",
        "buildArgsSha256",
        "releaseManifestSha256",
        "sha256sumsSha256",
        "validationStartedAtUtc",
        "validationCompletedAtUtc",
        "validationDurationSeconds",
        "maximumAgeSeconds",
        "validUntilUtc",
        "validatedAtUtc",
    }
    require(set(gate) == expected_keys, "activation gate fields are not exact")
    require(gate.get("schema") == "motorist-activation-gate/v1", "activation gate schema mismatch")
    require(gate.get("gateStatus") == "pass_activation", "activation gate did not pass")
    require(gate.get("sourceProjectRef") == SOURCE_REF, "activation gate source mismatch")
    require(gate.get("targetProjectRef") == TARGET_REF, "activation gate target mismatch")
    require(gate.get("cutoverReceiptSha256") == cutover_receipt_sha256, "activation gate cutover binding mismatch")
    expected_identity = {
        "releaseVersion": manifest["version"],
        "gitSha": manifest["gitSha"],
        "image": manifest["image"],
        "imageId": manifest["imageId"],
        "platform": manifest["platform"],
        "buildContextSha256": manifest["buildContextSha256"],
        "buildArgsSha256": manifest["buildArgsSha256"],
        "releaseManifestSha256": release_manifest_sha256,
        "sha256sumsSha256": sha256sums_sha256,
    }
    require(
        all(gate.get(key) == value for key, value in expected_identity.items()),
        "activation gate release identity mismatch",
    )
    require(
        gate.get("source") == {"persistentDatabaseFreeze": True, "activeCronJobs": 0},
        "activation gate source state is unsafe",
    )
    require(
        gate.get("target")
        == {
            "persistentDatabaseFreeze": False,
            "activeCronJobs": 0,
            "jobControlsTotal": len(ALL_JOBS),
            "jobControlsEnabled": 0,
            "jobControlSetExact": True,
        },
        "activation gate target state is unsafe",
    )
    require(
        gate.get("publicHttps") == {"live": True, "ready": True, "exactRelease": True},
        "activation gate HTTPS state is unsafe",
    )
    dns = gate.get("dns")
    require(
        isinstance(dns, dict)
        and set(dns) == {
            "authoritativeExactTarget",
            "recursiveExactTarget",
            "authoritativeNameserverCount",
        }
        and dns.get("authoritativeExactTarget") is True
        and dns.get("recursiveExactTarget") is True
        and type(dns.get("authoritativeNameserverCount")) is int
        and 1 <= dns["authoritativeNameserverCount"] <= 20,
        "activation gate DNS state is unsafe",
    )
    started_at = parse_utc(gate.get("validationStartedAtUtc"), "activation gate validationStartedAtUtc")
    completed_at = parse_utc(gate.get("validationCompletedAtUtc"), "activation gate validationCompletedAtUtc")
    validated_at = parse_utc(gate.get("validatedAtUtc"), "activation gate validatedAtUtc")
    valid_until = parse_utc(gate.get("validUntilUtc"), "activation gate validUntilUtc")
    duration = gate.get("validationDurationSeconds")
    require(type(duration) is int, "activation gate duration is invalid")
    require(started_at <= completed_at == validated_at, "activation gate timestamps are out of order")
    require(duration == int((completed_at - started_at).total_seconds()), "activation gate duration mismatch")
    require(0 <= duration <= 120, "activation gate validation exceeded 120 seconds")
    require(gate.get("maximumAgeSeconds") == MAX_GATE_AGE_SECONDS, "activation gate maximum age mismatch")
    require(valid_until == completed_at + dt.timedelta(seconds=MAX_GATE_AGE_SECONDS), "activation gate expiry mismatch")
    age = (utc_now() - completed_at).total_seconds()
    require(age >= -5, "activation gate timestamp is in the future")
    require(age <= MAX_GATE_AGE_SECONDS, "activation gate is older than five minutes")
    return gate_sha256


def safe_summary(summary: object) -> bool:
    if not isinstance(summary, dict):
        return False
    try:
        serialized = json.dumps(summary, sort_keys=True, separators=(",", ":"))
    except (TypeError, ValueError):
        return False
    if len(serialized.encode("utf-8")) > 8192:
        return False
    lowered = serialized.lower()
    if SOURCE_REF in serialized or TARGET_REF in serialized:
        return False
    if "http://" in lowered or "https://" in lowered or "@" in serialized:
        return False
    if PHONE_LIKE_PATTERN.search(serialized):
        return False
    return True


def validate_viptel_receipt(receipt: dict[str, Any]) -> dt.datetime:
    expected_fields = {
        "schema",
        "recordedAtUtc",
        "probeStartedAtUtc",
        "callWindowStartedAtUtc",
        "callWindowEndedAtUtc",
        "releaseVersion",
        "imageId",
        "runtimeEnvSha256",
        "targetProjectRef",
        "ok",
        "status",
        "listenerConnected",
        "listenerReconnected",
        "incomingCallTested",
        "outgoingCallTested",
        "summary",
    }
    require(set(receipt) == expected_fields, "VIPTel receipt fields are not exact")
    summary = receipt.get("summary")
    require(safe_summary(summary), "VIPTel receipt summary is not aggregate-only")
    require(
        isinstance(summary, dict)
        and set(summary)
        == {
            "websocketConnectionsObserved",
            "inboundCallsObserved",
            "outboundCallsObserved",
        }
        and all(type(value) is int and 0 <= value <= 999_999_999 for value in summary.values()),
        "VIPTel receipt aggregate schema is invalid",
    )
    connected = receipt.get("listenerConnected")
    reconnected = receipt.get("listenerReconnected")
    incoming = receipt.get("incomingCallTested")
    outgoing = receipt.get("outgoingCallTested")
    require(
        all(type(value) is bool for value in (connected, reconnected, incoming, outgoing)),
        "VIPTel receipt proof flags are invalid",
    )
    require(not reconnected or connected, "VIPTel receipt reconnect state is inconsistent")
    require(
        summary["websocketConnectionsObserved"]
        == (2 if reconnected else (1 if connected else 0)),
        "VIPTel receipt connection aggregate is inconsistent",
    )
    require(
        incoming == (summary["inboundCallsObserved"] > 0)
        and outgoing == (summary["outboundCallsObserved"] > 0),
        "VIPTel receipt call aggregates are inconsistent",
    )
    require(type(receipt.get("ok")) is bool, "VIPTel receipt outcome is invalid")
    require(receipt.get("status") in ("success", "failed"), "VIPTel receipt status is invalid")
    require(
        receipt["ok"] == (receipt["status"] == "success"),
        "VIPTel receipt outcome and status differ",
    )
    probe_started = parse_utc(receipt.get("probeStartedAtUtc"), "VIPTel probeStartedAtUtc")
    recorded_at = parse_utc(receipt.get("recordedAtUtc"), "VIPTel recordedAtUtc")
    call_window_value = receipt.get("callWindowStartedAtUtc")
    call_window_end_value = receipt.get("callWindowEndedAtUtc")
    if call_window_value is None or call_window_end_value is None:
        require(
            receipt.get("ok") is False
            and call_window_value is None
            and call_window_end_value is None,
            "VIPTel receipt has an incomplete call window",
        )
    else:
        call_window = parse_utc(call_window_value, "VIPTel callWindowStartedAtUtc")
        call_window_end = parse_utc(call_window_end_value, "VIPTel callWindowEndedAtUtc")
        require(
            probe_started <= call_window < call_window_end <= recorded_at,
            "VIPTel receipt timestamps are out of order",
        )
    require(probe_started <= recorded_at, "VIPTel receipt timestamps are out of order")
    return recorded_at


def exact_one_shot_summary(job: str, summary: object) -> bool:
    if not isinstance(summary, dict):
        return False
    numeric_fields = ONE_SHOT_NUMERIC_FIELDS.get(job)
    if numeric_fields is None:
        return False
    status_fields = ONE_SHOT_STATUS_FIELDS.get(job, {})
    if set(summary) != set(numeric_fields) | set(status_fields):
        return False
    if not all(
        type(summary.get(field)) is int and summary[field] >= 0
        for field in numeric_fields
    ):
        return False
    return all(summary.get(field) == value for field, value in status_fields.items())


def idempotency_summary_ok(job: str, summary: object, *, second_run: bool) -> bool:
    if not exact_one_shot_summary(job, summary):
        return False
    zero_fields = {
        "fleet.commander.positions": ("errorCount",),
        "fleet.commander.catalog": ("errorCount",),
        "notifications.materialize": ("failed",),
        "telephony.recordings.sync": ("failed",),
        "telephony.transcripts.process": ("failed", "aiFailed"),
    }.get(job, ())
    if not all(summary.get(field) == 0 for field in zero_fields):
        return False
    if second_run and job == "fleet.commander.catalog":
        return summary.get("createdCount") == 0
    return True


def validate_one_shot_receipts(
    directory: Path,
    manifest: dict[str, Any],
    jobs: list[str],
    require_listener: bool,
    worker_env_sha256: str,
    listener_env_sha256: str,
) -> list[dict[str, Any]]:
    receipt_dir = require_safe_directory(directory, private=True)
    entries = sorted(receipt_dir.iterdir())
    require(len(entries) <= 200, "one-shot receipt directory has too many entries")
    job_candidates: dict[str, list[tuple[dt.datetime, str, dict[str, Any]]]] = {
        job: [] for job in jobs
    }
    listener_candidates: list[tuple[dt.datetime, str, dict[str, Any]]] = []
    now = utc_now()
    for path in entries:
        if path.name.startswith("."):
            continue
        require(path.suffix == ".json", "one-shot receipt directory contains an unknown entry")
        receipt_bytes = read_bytes(path, private=True)
        try:
            receipt = json.loads(receipt_bytes)
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise SystemExit(f"{path} is not valid JSON") from error
        require(isinstance(receipt, dict), f"{path} must contain a JSON object")
        receipt_sha256 = hashlib.sha256(receipt_bytes).hexdigest()
        schema = receipt.get("schema")
        if schema == "motorist-one-shot/v1":
            job = receipt.get("job")
            require(job in ACTIVATABLE_JOBS, "one-shot receipt contains a denied job")
            require(receipt.get("targetProjectRef") == TARGET_REF, "one-shot target mismatch")
            require(receipt.get("releaseVersion") == manifest["version"], "one-shot release mismatch")
            require(receipt.get("imageId") == manifest["imageId"], "one-shot image mismatch")
            require(
                receipt.get("runtimeEnvSha256") == worker_env_sha256,
                "one-shot runtime binding mismatch",
            )
            require(safe_summary(receipt.get("summary")), "one-shot summary is not aggregate-only")
            if receipt.get("ok") is True and receipt.get("status") == "success":
                require(
                    exact_one_shot_summary(job, receipt.get("summary")),
                    "one-shot summary contract is invalid",
                )
            else:
                require(receipt.get("summary") == {}, "failed one-shot summary must be empty")
            recorded_at = parse_utc(receipt.get("recordedAtUtc"), "one-shot recordedAtUtc")
            if job in jobs:
                job_candidates[job].append((recorded_at, receipt_sha256, receipt))
        elif schema == "motorist-viptel-listener/v2":
            require(receipt.get("targetProjectRef") == TARGET_REF, "VIPTel receipt target mismatch")
            require(receipt.get("releaseVersion") == manifest["version"], "VIPTel receipt release mismatch")
            require(receipt.get("imageId") == manifest["imageId"], "VIPTel receipt image mismatch")
            require(
                receipt.get("runtimeEnvSha256") == listener_env_sha256,
                "VIPTel runtime binding mismatch",
            )
            recorded_at = validate_viptel_receipt(receipt)
            listener_candidates.append((recorded_at, receipt_sha256, receipt))
        else:
            raise SystemExit("one-shot receipt schema is unknown")
    bindings: list[dict[str, Any]] = []
    for job in sorted(jobs):
        ordered = sorted(job_candidates[job], key=lambda candidate: (candidate[0], candidate[1]))
        require(len(ordered) >= 2, "two exact-release one-shot receipts are required")
        verified_pair = ordered[-2:]
        for pair_index, (recorded_at, _receipt_sha256, receipt) in enumerate(verified_pair):
            age = (now - recorded_at).total_seconds()
            require(-5 <= age <= MAX_ONE_SHOT_AGE_SECONDS, "one-shot receipt pair is not recent")
            require(
                receipt.get("ok") is True and receipt.get("status") == "success",
                "latest one-shot receipt pair did not succeed",
            )
            require(
                idempotency_summary_ok(
                    job,
                    receipt.get("summary"),
                    second_run=pair_index == 1,
                ),
                "one-shot idempotency summary is unsafe",
            )
        bindings.append(
            {"job": job, "sha256s": [candidate[1] for candidate in verified_pair]}
        )
    if require_listener:
        require(listener_candidates, "an exact-release VIPTel listener receipt is missing")
        recorded_at, receipt_sha256, receipt = max(
            listener_candidates, key=lambda candidate: (candidate[0], candidate[1])
        )
        age = (now - recorded_at).total_seconds()
        require(-5 <= age <= MAX_ONE_SHOT_AGE_SECONDS, "latest VIPTel receipt is not recent")
        require(
            receipt.get("ok") is True
            and receipt.get("status") == "success"
            and receipt.get("incomingCallTested") is True
            and receipt.get("outgoingCallTested") is True
            and receipt.get("listenerConnected") is True
            and receipt.get("listenerReconnected") is True,
            "latest VIPTel listener receipt did not succeed",
        )
        bindings.append(
            {
                "job": "telephony.viptel.listener",
                "sha256s": [receipt_sha256],
            }
        )
    return sorted(bindings, key=lambda binding: binding["job"])


def preflight(args: argparse.Namespace) -> None:
    production_dir = require_safe_directory(Path(args.production_dir))
    expected_bin_dir = require_safe_directory(production_dir / "bin")
    supplied_script_dir = require_safe_directory(Path(args.activation_script_dir))
    require(supplied_script_dir == expected_bin_dir, "activation script is outside the release bin directory")
    require(
        Path(__file__).resolve().parent == expected_bin_dir,
        "activation validator is outside the release bin directory",
    )
    manifest = load_manifest(production_dir)
    release_sha256 = validate_release_integrity(production_dir)
    jobs = parse_jobs(args.jobs, allow_empty=args.enable_viptel_listener)
    require(jobs or args.enable_viptel_listener, "nothing was selected for activation")
    cutover_path = Path(args.cutover_receipt)
    gate_path = Path(args.activation_gate)
    _cutover_gate_sha256, cutover_release_sha256 = validate_cutover_receipt(
        cutover_path, manifest
    )
    require(
        release_sha256 == cutover_release_sha256,
        "production release is not the release bound into the successful cutover receipt",
    )
    cutover_sha256 = hashlib.sha256(read_bytes(cutover_path, private=True)).hexdigest()
    release_manifest_sha256 = hashlib.sha256(
        read_bytes(production_dir / "manifest.json", private=False)
    ).hexdigest()
    gate_sha256 = validate_activation_gate(
        gate_path,
        manifest,
        cutover_sha256,
        release_manifest_sha256,
        release_sha256,
    )
    worker_path = production_dir / "env" / "worker.env"
    listener_path = production_dir / "env" / "viptel-listener.env"
    worker_before = read_bytes(worker_path, private=True)
    listener_before = read_bytes(listener_path, private=True)
    worker_env, _, listener_env, _ = load_runtime(
        production_dir, manifest["version"], require_initially_disabled=True
    )
    worker_after = read_bytes(worker_path, private=True)
    listener_after = read_bytes(listener_path, private=True)
    require(worker_before == worker_after, "worker runtime changed during validation")
    require(listener_before == listener_after, "VIPTel runtime changed during validation")
    try:
        job_healthchecks = json.loads(worker_env.get("HEALTHCHECKS_JOB_URLS_JSON", ""))
    except json.JSONDecodeError as error:
        raise SystemExit("job Healthchecks mapping is invalid") from error
    require(isinstance(job_healthchecks, dict), "job Healthchecks mapping is invalid")
    require(
        all(
            isinstance(name, str)
            and name in ACTIVATABLE_JOBS
            and isinstance(value, str)
            for name, value in job_healthchecks.items()
        ),
        "job Healthchecks mapping contains an unknown entry",
    )
    for job in jobs:
        validate_healthchecks_url(job_healthchecks.get(job), f"Healthchecks URL for {job}")
    worker_env_sha256 = hashlib.sha256(worker_after).hexdigest()
    listener_env_sha256 = hashlib.sha256(listener_after).hexdigest()
    one_shot_bindings = validate_one_shot_receipts(
        Path(args.one_shot_receipt_dir),
        manifest,
        jobs,
        args.enable_viptel_listener,
        worker_env_sha256,
        listener_env_sha256,
    )
    if args.output == "lines":
        print(manifest["version"])
        print(manifest["image"])
        print(manifest["imageId"])
        print(",".join(jobs))
        print("true" if args.enable_viptel_listener else "false")
        print(cutover_sha256)
        print(gate_sha256)
        print(json.dumps(one_shot_bindings, sort_keys=True, separators=(",", ":")))
        print(worker_env_sha256)
        print(listener_env_sha256)
    else:
        print(
            json.dumps(
                {
                    "ok": True,
                    "releaseVersion": manifest["version"],
                    "image": manifest["image"],
                    "imageId": manifest["imageId"],
                    "jobs": jobs,
                    "enableViptelListener": args.enable_viptel_listener,
                    "cutoverReceiptSha256": cutover_sha256,
                    "activationGateSha256": gate_sha256,
                    "oneShotReceiptBindings": one_shot_bindings,
                    "workerRuntimeSha256": worker_env_sha256,
                    "listenerRuntimeSha256": listener_env_sha256,
                },
                sort_keys=True,
                separators=(",", ":"),
            )
        )


def revalidate_gate(args: argparse.Namespace) -> None:
    production_dir = require_safe_directory(Path(args.production_dir))
    expected_bin_dir = require_safe_directory(production_dir / "bin")
    supplied_script_dir = require_safe_directory(Path(args.activation_script_dir))
    require(
        supplied_script_dir == expected_bin_dir,
        "activation script is outside the release bin directory",
    )
    require(
        Path(__file__).resolve().parent == expected_bin_dir,
        "activation validator is outside the release bin directory",
    )
    manifest = load_manifest(production_dir)
    require(
        manifest["version"] == args.release_version,
        "release changed after activation preflight",
    )
    release_sha256 = validate_release_integrity(production_dir)
    cutover_path = Path(args.cutover_receipt)
    cutover_sha256 = hashlib.sha256(
        read_bytes(cutover_path, private=True)
    ).hexdigest()
    require(
        re.fullmatch(r"[0-9a-f]{64}", args.expected_cutover_sha256) is not None
        and cutover_sha256 == args.expected_cutover_sha256,
        "cutover receipt changed after activation preflight",
    )
    _cutover_gate_sha256, cutover_release_sha256 = validate_cutover_receipt(
        cutover_path,
        manifest,
    )
    require(
        hashlib.sha256(read_bytes(cutover_path, private=True)).hexdigest()
        == args.expected_cutover_sha256,
        "cutover receipt changed during gate revalidation",
    )
    require(
        release_sha256 == cutover_release_sha256,
        "production release is not the release bound into the successful cutover receipt",
    )
    release_manifest_sha256 = hashlib.sha256(
        read_bytes(production_dir / "manifest.json", private=False)
    ).hexdigest()
    validate_activation_gate(
        Path(args.activation_gate),
        manifest,
        cutover_sha256,
        release_manifest_sha256,
        release_sha256,
        expected_sha256=args.expected_gate_sha256,
    )


def atomic_write_env(path: Path, env: dict[str, str], order: list[str]) -> None:
    directory = path.parent
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=directory)
    try:
        os.fchmod(descriptor, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8", closefd=True) as output:
            for key in order:
                output.write(
                    f"{key}={json.dumps(env[key], ensure_ascii=False, separators=(',', ':'))}\n"
                )
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        directory_descriptor = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def set_flags(args: argparse.Namespace) -> None:
    production_dir = require_safe_directory(Path(args.production_dir))
    manifest = load_manifest(production_dir)
    require(manifest["version"] == args.release_version, "release changed before flag update")
    worker_path = production_dir / "env" / "worker.env"
    listener_path = production_dir / "env" / "viptel-listener.env"
    worker_before = read_bytes(worker_path, private=True)
    listener_before = read_bytes(listener_path, private=True)
    if args.force_disable:
        require(
            args.scheduler == "false" and args.listener == "false",
            "force-disable may only turn both runtimes off",
        )
    else:
        require(
            re.fullmatch(r"[0-9a-f]{64}", args.expected_worker_sha256 or "") is not None
            and re.fullmatch(r"[0-9a-f]{64}", args.expected_listener_sha256 or "") is not None,
            "expected runtime fingerprints are required",
        )
        require(
            hashlib.sha256(worker_before).hexdigest() == args.expected_worker_sha256,
            "worker runtime changed after preflight",
        )
        require(
            hashlib.sha256(listener_before).hexdigest() == args.expected_listener_sha256,
            "VIPTel runtime changed after preflight",
        )
    worker, worker_order, listener, listener_order = load_runtime(
        production_dir,
        args.release_version,
        require_initially_disabled=False,
    )
    require(worker_before == read_bytes(worker_path, private=True), "worker runtime changed during flag update")
    require(listener_before == read_bytes(listener_path, private=True), "VIPTel runtime changed during flag update")
    worker["SCHEDULER_ENABLED"] = args.scheduler
    listener["VIPTEL_LISTENER_ENABLED"] = args.listener
    atomic_write_env(worker_path, worker, worker_order)
    atomic_write_env(
        listener_path,
        listener,
        listener_order,
    )
    worker_sha256 = hashlib.sha256(read_bytes(worker_path, private=True)).hexdigest()
    listener_sha256 = hashlib.sha256(read_bytes(listener_path, private=True)).hexdigest()
    if args.output == "lines":
        print(worker_sha256)
        print(listener_sha256)


def validate_listener_authority(listener: dict[str, str]) -> None:
    token = listener.get("VIPTEL_LIVE_MUTATION_TOKEN")
    require(isinstance(token, str), "VIPTel live-mutation authority is missing")
    require(token == token.strip(), "VIPTel live-mutation authority has surrounding whitespace")
    require(32 <= len(token) <= 1024, "VIPTel live-mutation authority length is invalid")
    require(
        all(ord(character) >= 0x21 and ord(character) != 0x7F for character in token),
        "VIPTel live-mutation authority contains unsafe characters",
    )


def validate_provider_snapshot_bridge(
    runtime: dict[str, str],
    *,
    require_personal_extensions: bool,
    expected_enabled: bool | None = None,
) -> None:
    enabled = runtime.get("VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_ENABLED")
    require(
        enabled in (None, "true", "false"),
        "VIPTel provider snapshot bridge flag is invalid",
    )
    require(
        not any(key.startswith("NEXT_PUBLIC_VIPTEL_PROVIDER_SNAPSHOT_") for key in runtime),
        "VIPTel provider snapshot bridge authority must remain server-only",
    )
    if expected_enabled is not None:
        require(
            enabled == ("true" if expected_enabled else "false"),
            "VIPTel provider snapshot bridge is not in the required state",
        )
    if enabled == "true":
        token = runtime.get("VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_TOKEN")
        require(isinstance(token, str), "VIPTel provider snapshot bridge authority is missing")
        require(token == token.strip(), "VIPTel provider snapshot bridge authority has whitespace")
        require(
            32 <= len(token) <= 1024,
            "VIPTel provider snapshot bridge authority length is invalid",
        )
        require(
            all(ord(character) >= 0x21 and ord(character) != 0x7F for character in token),
            "VIPTel provider snapshot bridge authority contains unsafe characters",
        )
    if require_personal_extensions:
        require(
            runtime.get("VIPTEL_DISPATCH_PERSONAL_EXTENSIONS") == "20,21,22,23",
            "VIPTel personal extension allowlist must be exactly 20,21,22,23",
        )


def validate_cross_runtime_viptel_authorities(
    web: dict[str, str], listener: dict[str, str]
) -> None:
    require(
        web.get("VIPTEL_LIVE_MUTATION_TOKEN")
        == listener.get("VIPTEL_LIVE_MUTATION_TOKEN"),
        "web/listener VIPTel live-mutation authority mismatch",
    )
    require(
        web.get("VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_TOKEN")
        == listener.get("VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_TOKEN"),
        "web/listener VIPTel provider snapshot bridge authority mismatch",
    )
    live_token = web.get("VIPTEL_LIVE_MUTATION_TOKEN")
    bridge_token = web.get("VIPTEL_PROVIDER_SNAPSHOT_BRIDGE_TOKEN")
    if live_token and bridge_token:
        require(
            live_token != bridge_token,
            "VIPTel live-mutation and provider snapshot authorities must differ",
        )


def load_listener_activation_runtime(
    production_dir: Path,
    release_version: str,
    *,
    expected_enabled: bool | None,
    require_authority: bool,
) -> tuple[dict[str, str], list[str]]:
    worker, _, listener, listener_order = load_runtime(
        production_dir,
        release_version,
        require_initially_disabled=False,
    )
    web, _ = parse_env(production_dir / "env" / "web.env")
    validate_cross_runtime_viptel_authorities(web, listener)
    require(worker.get("SCHEDULER_ENABLED") == "false", "worker scheduler runtime is enabled")
    require(
        not any(key.startswith("SCHEDULER_") for key in listener),
        "VIPTel listener runtime contains scheduler state",
    )
    require(
        "VIPTEL_LIVE_MUTATIONS_ENABLED" in listener_order
        and "VIPTEL_LIVE_MUTATION_TOKEN" in listener_order,
        "VIPTel listener live-mutation controls are missing",
    )
    listener_enabled = listener.get("VIPTEL_LISTENER_ENABLED")
    mutation_enabled = listener.get("VIPTEL_LIVE_MUTATIONS_ENABLED")
    require(
        listener_enabled in ("true", "false")
        and mutation_enabled in ("true", "false"),
        "VIPTel listener activation flags are invalid",
    )
    require(
        listener_enabled == mutation_enabled,
        "VIPTel listener and live-mutation flags differ",
    )
    if expected_enabled is not None:
        expected_value = "true" if expected_enabled else "false"
        require(
            listener_enabled == expected_value,
            "VIPTel listener activation state is not the expected value",
        )
    if require_authority:
        validate_listener_authority(listener)
    validate_provider_snapshot_bridge(
        listener,
        require_personal_extensions=True,
        expected_enabled=True,
    )
    return listener, listener_order


def set_listener_flags(args: argparse.Namespace) -> None:
    production_dir = require_safe_directory(Path(args.production_dir))
    manifest = load_manifest(production_dir)
    require(manifest["version"] == args.release_version, "release changed before listener flag update")
    listener_path = production_dir / "env" / "viptel-listener.env"
    listener_before = read_bytes(listener_path, private=True)
    expected_enabled = args.enabled == "true"

    if args.force_disable:
        require(not expected_enabled, "force-disable may only turn the listener off")
        listener, listener_order = parse_env(listener_path)
        require(
            listener.get("DEPLOYMENT_VERSION") == args.release_version,
            "VIPTel runtime release mismatch during force-disable",
        )
        require(
            listener.get("VIPTEL_LISTENER_INSTANCE_ID") == "motorist-prod-01-viptel",
            "VIPTel listener identity mismatch during force-disable",
        )
        require(
            "VIPTEL_LISTENER_ENABLED" in listener_order
            and "VIPTEL_LIVE_MUTATIONS_ENABLED" in listener_order,
            "VIPTel listener activation flags are missing",
        )
    else:
        require(
            re.fullmatch(r"[0-9a-f]{64}", args.expected_listener_sha256 or "") is not None,
            "expected VIPTel runtime fingerprint is required",
        )
        require(
            hashlib.sha256(listener_before).hexdigest() == args.expected_listener_sha256,
            "VIPTel runtime changed after listener preflight",
        )
        listener, listener_order = load_listener_activation_runtime(
            production_dir,
            args.release_version,
            expected_enabled=False if expected_enabled else None,
            require_authority=expected_enabled,
        )

    require(
        listener_before == read_bytes(listener_path, private=True),
        "VIPTel runtime changed during listener flag update",
    )
    enabled_value = "true" if expected_enabled else "false"
    listener["VIPTEL_LISTENER_ENABLED"] = enabled_value
    listener["VIPTEL_LIVE_MUTATIONS_ENABLED"] = enabled_value
    atomic_write_env(listener_path, listener, listener_order)
    listener_sha256 = hashlib.sha256(read_bytes(listener_path, private=True)).hexdigest()
    if args.output == "hash":
        print(listener_sha256)


def verify_listener_runtime(args: argparse.Namespace) -> None:
    production_dir = require_safe_directory(Path(args.production_dir))
    manifest = load_manifest(production_dir)
    require(manifest["version"] == args.release_version, "release changed before listener verification")
    listener_path = production_dir / "env" / "viptel-listener.env"
    require(
        hashlib.sha256(read_bytes(listener_path, private=True)).hexdigest()
        == args.expected_listener_sha256,
        "VIPTel runtime changed before listener start",
    )
    load_listener_activation_runtime(
        production_dir,
        args.release_version,
        expected_enabled=args.enabled == "true",
        require_authority=args.require_authority,
    )


def load_handover_listener_runtime(
    production_dir: Path,
    release_version: str,
    *,
    expected_enabled: bool,
    require_live_mutation_controls: bool,
) -> tuple[dict[str, str], list[str]]:
    require_safe_directory(production_dir / "env")
    listener_path = production_dir / "env" / "viptel-listener.env"
    listener, listener_order = parse_env(listener_path)
    if require_live_mutation_controls:
        web, _ = parse_env(production_dir / "env" / "web.env")
        validate_cross_runtime_viptel_authorities(web, listener)
    validate_shared_env(listener, release_version)
    require(
        listener.get("VIPTEL_LISTENER_INSTANCE_ID") == "motorist-prod-01-viptel",
        "VIPTel listener identity mismatch",
    )
    validate_healthchecks_url(
        listener.get("VIPTEL_HEALTHCHECKS_PING_URL"),
        "VIPTel Healthchecks URL",
    )
    require(
        not any(key.startswith("SCHEDULER_") for key in listener),
        "VIPTel listener runtime contains scheduler state",
    )
    expected_value = "true" if expected_enabled else "false"
    require(
        listener.get("VIPTEL_LISTENER_ENABLED") == expected_value,
        "VIPTel listener handover state is not the expected value",
    )
    if require_live_mutation_controls:
        require(
            "VIPTEL_LIVE_MUTATIONS_ENABLED" in listener_order
            and "VIPTEL_LIVE_MUTATION_TOKEN" in listener_order,
            "VIPTel listener live-mutation controls are missing",
        )
        require(
            listener.get("VIPTEL_LIVE_MUTATIONS_ENABLED") == expected_value,
            "VIPTel listener and live-mutation handover flags differ",
        )
        validate_listener_authority(listener)
        validate_provider_snapshot_bridge(
            listener,
            require_personal_extensions=True,
            expected_enabled=True,
        )
    return listener, listener_order


def verify_handover_old_runtime(args: argparse.Namespace) -> None:
    production_dir = require_safe_directory(Path(args.production_dir))
    manifest = load_manifest(production_dir)
    require(manifest["version"] == args.release_version, "old runtime release mismatch")
    worker_path = production_dir / "env" / "worker.env"
    listener_path = production_dir / "env" / "viptel-listener.env"
    worker_bytes = read_bytes(worker_path, private=True)
    listener_bytes = read_bytes(listener_path, private=True)
    require(
        hashlib.sha256(worker_bytes).hexdigest() == args.expected_worker_sha256,
        "old worker runtime changed during handover",
    )
    require(
        hashlib.sha256(listener_bytes).hexdigest() == args.expected_listener_sha256,
        "old VIPTel runtime changed during handover",
    )
    worker, _ = parse_env(worker_path)
    validate_shared_env(worker, args.release_version)
    require(worker.get("WORKER_INSTANCE_ID") == "motorist-prod-01", "worker identity mismatch")
    require(worker.get("SCHEDULER_ENABLED") == "true", "old worker scheduler is not enabled")
    validate_healthchecks_url(worker.get("HEALTHCHECKS_PING_URL"), "worker Healthchecks URL")
    load_handover_listener_runtime(
        production_dir,
        args.release_version,
        expected_enabled=True,
        require_live_mutation_controls=False,
    )


def verify_handover_worker_runtime(args: argparse.Namespace) -> None:
    """Bind a preserved worker to its own historic release and private runtime."""

    production_dir = require_safe_directory(Path(args.production_dir))
    manifest = load_manifest(production_dir)
    require(manifest["version"] == args.release_version, "worker runtime release mismatch")
    require(
        re.fullmatch(r"[0-9a-f]{64}", args.expected_worker_sha256) is not None,
        "expected worker runtime fingerprint is invalid",
    )
    worker_path = production_dir / "env" / "worker.env"
    worker_bytes = read_bytes(worker_path, private=True)
    require(
        hashlib.sha256(worker_bytes).hexdigest() == args.expected_worker_sha256,
        "preserved worker runtime changed during handover",
    )
    worker, _ = parse_env(worker_path)
    validate_shared_env(worker, args.release_version)
    require(worker.get("WORKER_INSTANCE_ID") == "motorist-prod-01", "worker identity mismatch")
    require(worker.get("SCHEDULER_ENABLED") == "true", "preserved worker scheduler is not enabled")
    validate_healthchecks_url(worker.get("HEALTHCHECKS_PING_URL"), "worker Healthchecks URL")


def verify_handover_listener_runtime(args: argparse.Namespace) -> None:
    """Bind the active rollback listener to its distinct historic release."""

    production_dir = require_safe_directory(Path(args.production_dir))
    manifest = load_manifest(production_dir)
    require(manifest["version"] == args.release_version, "listener runtime release mismatch")
    require(
        re.fullmatch(r"[0-9a-f]{64}", args.expected_listener_sha256) is not None,
        "expected listener runtime fingerprint is invalid",
    )
    listener_path = production_dir / "env" / "viptel-listener.env"
    listener_bytes = read_bytes(listener_path, private=True)
    require(
        hashlib.sha256(listener_bytes).hexdigest() == args.expected_listener_sha256,
        "preserved VIPTel runtime changed during handover",
    )
    load_handover_listener_runtime(
        production_dir,
        args.release_version,
        expected_enabled=args.enabled == "true",
        require_live_mutation_controls=True,
    )


def verify_handover_new_runtime(args: argparse.Namespace) -> None:
    production_dir = require_safe_directory(Path(args.production_dir))
    manifest = load_manifest(production_dir)
    require(manifest["version"] == args.release_version, "new runtime release mismatch")
    listener_path = production_dir / "env" / "viptel-listener.env"
    require(
        hashlib.sha256(read_bytes(listener_path, private=True)).hexdigest()
        == args.expected_listener_sha256,
        "new VIPTel runtime changed during handover",
    )
    load_handover_listener_runtime(
        production_dir,
        args.release_version,
        expected_enabled=args.enabled == "true",
        require_live_mutation_controls=True,
    )


def verify_handover_stage_runtime(args: argparse.Namespace) -> None:
    production_dir = require_safe_directory(Path(args.production_dir))
    manifest = load_manifest(production_dir)
    require(manifest["version"] == args.release_version, "staged runtime release mismatch")
    env_dir = require_safe_directory(production_dir / "env", private=True)
    web, _ = parse_env(env_dir / "web.env")
    worker, _ = parse_env(env_dir / "worker.env")
    listener, _ = parse_env(env_dir / "viptel-listener.env")
    caddy, _ = parse_env(env_dir / "caddy.env")
    for runtime in (web, worker, listener):
        validate_shared_env(runtime, args.release_version)
        require(
            not any(key.startswith("NEXT_PUBLIC_VIPTEL_LIVE_") for key in runtime),
            "VIPTel live-mutation authority must remain server-only",
        )
        require("NEXT_SERVER_ACTIONS_ENCRYPTION_KEY" not in runtime, "runtime Server Actions key is forbidden")
        require("SUPABASE_JWT_SECRET" not in runtime, "legacy JWT secret is forbidden")
        require("VERCEL" not in runtime, "Vercel marker is forbidden in staged runtime")
        validate_provider_snapshot_bridge(runtime, require_personal_extensions=False)
    validate_cross_runtime_viptel_authorities(web, listener)
    require(
        not any(key.startswith("SCHEDULER_") for key in web),
        "staged web runtime contains scheduler state",
    )
    require(worker.get("SCHEDULER_ENABLED") == "false", "staged worker scheduler must be disabled")
    require(worker.get("WORKER_INSTANCE_ID") == "motorist-prod-01", "staged worker identity mismatch")
    validate_healthchecks_url(worker.get("HEALTHCHECKS_PING_URL"), "worker Healthchecks URL")
    load_handover_listener_runtime(
        production_dir,
        args.release_version,
        expected_enabled=False,
        require_live_mutation_controls=True,
    )
    require(caddy.get("APP_DOMAIN") == "dispecing.linkapomoci.sk", "staged Caddy domain mismatch")
    require(bool(caddy.get("ACME_EMAIL")), "staged Caddy ACME email is missing")
    require(
        all(SOURCE_REF not in value for value in caddy.values()),
        "source project ref is present in staged Caddy runtime",
    )


def set_handover_listener_flags(args: argparse.Namespace) -> None:
    production_dir = require_safe_directory(Path(args.production_dir))
    manifest = load_manifest(production_dir)
    require(manifest["version"] == args.release_version, "new runtime release mismatch")
    listener_path = production_dir / "env" / "viptel-listener.env"
    listener_before = read_bytes(listener_path, private=True)
    expected_enabled = args.enabled == "true"
    if args.force_disable:
        require(not expected_enabled, "force-disable may only turn the listener off")
        listener, listener_order = parse_env(listener_path)
        require(
            listener.get("DEPLOYMENT_VERSION") == args.release_version
            and listener.get("VIPTEL_LISTENER_INSTANCE_ID") == "motorist-prod-01-viptel",
            "new VIPTel runtime identity mismatch during force-disable",
        )
        require(
            "VIPTEL_LISTENER_ENABLED" in listener_order
            and "VIPTEL_LIVE_MUTATIONS_ENABLED" in listener_order,
            "new VIPTel activation flags are missing",
        )
    else:
        require(
            re.fullmatch(r"[0-9a-f]{64}", args.expected_listener_sha256 or "") is not None,
            "expected new VIPTel runtime fingerprint is required",
        )
        require(
            hashlib.sha256(listener_before).hexdigest() == args.expected_listener_sha256,
            "new VIPTel runtime changed after handover preflight",
        )
        listener, listener_order = load_handover_listener_runtime(
            production_dir,
            args.release_version,
            expected_enabled=False if expected_enabled else True,
            require_live_mutation_controls=True,
        )
    require(
        listener_before == read_bytes(listener_path, private=True),
        "new VIPTel runtime changed during handover flag update",
    )
    enabled_value = "true" if expected_enabled else "false"
    listener["VIPTEL_LISTENER_ENABLED"] = enabled_value
    listener["VIPTEL_LIVE_MUTATIONS_ENABLED"] = enabled_value
    atomic_write_env(listener_path, listener, listener_order)
    if args.output == "hash":
        print(hashlib.sha256(read_bytes(listener_path, private=True)).hexdigest())


def verify_runtime(args: argparse.Namespace) -> None:
    production_dir = require_safe_directory(Path(args.production_dir))
    manifest = load_manifest(production_dir)
    require(manifest["version"] == args.release_version, "release changed before runtime verification")
    require(
        hashlib.sha256(read_bytes(production_dir / "env" / "worker.env", private=True)).hexdigest()
        == args.expected_worker_sha256,
        "worker runtime changed before container start",
    )
    require(
        hashlib.sha256(
            read_bytes(production_dir / "env" / "viptel-listener.env", private=True)
        ).hexdigest()
        == args.expected_listener_sha256,
        "VIPTel runtime changed before container start",
    )


def rest_request(
    env: dict[str, str],
    method: str,
    path: str,
    body: object | None = None,
) -> object:
    encoded = None
    headers = {
        "apikey": env["SUPABASE_SECRET_KEY"],
        "Authorization": f"Bearer {env['SUPABASE_SECRET_KEY']}",
        "Accept": "application/json",
    }
    if body is not None:
        encoded = json.dumps(body, separators=(",", ":")).encode("utf-8")
        headers["Content-Type"] = "application/json"
        headers["Prefer"] = "return=representation"
    request = urllib.request.Request(
        f"{TARGET_URL}/rest/v1/{path}", data=encoded, headers=headers, method=method
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            payload = response.read(256 * 1024 + 1)
    except (OSError, urllib.error.URLError, urllib.error.HTTPError) as error:
        raise SystemExit("target REST request failed") from error
    require(len(payload) <= 256 * 1024, "target REST response is too large")
    if not payload:
        return None
    try:
        return json.loads(payload)
    except json.JSONDecodeError as error:
        raise SystemExit("target REST response is invalid") from error


def load_live_env(production_dir_arg: str, release_version: str) -> dict[str, str]:
    production_dir = require_safe_directory(Path(production_dir_arg))
    manifest = load_manifest(production_dir)
    require(manifest["version"] == release_version, "release changed before REST operation")
    worker, _, _, _ = load_runtime(
        production_dir,
        release_version,
        require_initially_disabled=False,
    )
    return worker


def fetch_controls(env: dict[str, str]) -> dict[str, bool]:
    query = urllib.parse.urlencode(
        {"select": "job_name,enabled", "order": "job_name.asc"}
    )
    response = rest_request(env, "GET", f"motorist_job_controls?{query}")
    require(isinstance(response, list), "target job-control response is invalid")
    controls: dict[str, bool] = {}
    for row in response:
        require(isinstance(row, dict), "target job-control row is invalid")
        job = row.get("job_name")
        enabled = row.get("enabled")
        require(job in ALL_JOBS and type(enabled) is bool, "target job-control row is invalid")
        require(job not in controls, "target job controls contain duplicates")
        controls[job] = enabled
    require(set(controls) == set(ALL_JOBS), "target does not contain exactly 11 job controls")
    return controls


def set_controls(args: argparse.Namespace) -> None:
    jobs = parse_jobs(args.jobs, allow_empty=True)
    env = load_live_env(args.production_dir, args.release_version)
    if args.mode == "enable":
        require(jobs, "at least one job is required for enable")
        require(not any(fetch_controls(env).values()), "job controls were not initially disabled")
        filter_value = f"in.({','.join(jobs)})"
        query = urllib.parse.urlencode(
            {"job_name": filter_value, "select": "job_name,enabled"}
        )
        response = rest_request(
            env,
            "PATCH",
            f"motorist_job_controls?{query}",
            {"enabled": True, "updated_at": utc_now().strftime("%Y-%m-%dT%H:%M:%SZ")},
        )
        require(isinstance(response, list), "target control update response is invalid")
        updated = {
            row.get("job_name")
            for row in response
            if isinstance(row, dict) and row.get("enabled") is True
        }
        require(updated == set(jobs), "target did not enable the exact requested job set")
    elif args.mode == "disable":
        require(jobs, "at least one job is required for selective disable")
        before = fetch_controls(env)
        filter_value = f"in.({','.join(jobs)})"
        query = urllib.parse.urlencode(
            {"job_name": filter_value, "select": "job_name,enabled"}
        )
        response = rest_request(
            env,
            "PATCH",
            f"motorist_job_controls?{query}",
            {"enabled": False, "updated_at": utc_now().strftime("%Y-%m-%dT%H:%M:%SZ")},
        )
        require(isinstance(response, list), "target control update response is invalid")
        updated = {
            row.get("job_name")
            for row in response
            if isinstance(row, dict) and row.get("enabled") is False
        }
        require(updated == set(jobs), "target did not disable the exact requested job set")
        after = fetch_controls(env)
        require(
            all(not after[job] for job in jobs),
            "target requested job controls remain enabled",
        )
        require(
            all(after[job] == before[job] for job in ALL_JOBS if job not in jobs),
            "an unrelated target job control changed during selective disable",
        )
    else:
        query = urllib.parse.urlencode(
            {"enabled": "eq.true", "select": "job_name,enabled"}
        )
        rest_request(
            env,
            "PATCH",
            f"motorist_job_controls?{query}",
            {"enabled": False, "updated_at": utc_now().strftime("%Y-%m-%dT%H:%M:%SZ")},
        )
        require(not any(fetch_controls(env).values()), "target job controls could not be disabled")


def controls_state(args: argparse.Namespace) -> None:
    jobs = parse_jobs(args.jobs, allow_empty=True)
    env = load_live_env(args.production_dir, args.release_version)
    controls = fetch_controls(env)
    enabled = {job for job, is_enabled in controls.items() if is_enabled}
    require(enabled == set(jobs), "target enabled-job set is not exact")


def validate_listener_only_heartbeat_rows(
    rows: object,
    release_version: str,
    phase: str,
    require_fresh_disabled_worker: bool = False,
    require_fresh_disabled_listener: bool = False,
) -> None:
    require(isinstance(rows, list), "target heartbeat response is invalid")
    by_instance: dict[str, dict[str, Any]] = {}
    allowed_instances = {"motorist-prod-01", "motorist-prod-01-viptel"}
    for row in rows:
        require(isinstance(row, dict), "target heartbeat row is invalid")
        instance = row.get("instance_id")
        require(instance in allowed_instances, "an unexpected runtime heartbeat exists")
        require(instance not in by_instance, "target heartbeat identity is duplicated")
        parse_utc(row.get("heartbeat_at"), "heartbeat_at")
        by_instance[instance] = row

    worker = by_instance.get("motorist-prod-01")
    if require_fresh_disabled_worker:
        require(worker is not None, "running worker heartbeat is missing")
    if worker is not None:
        require(worker.get("scheduler_status") == "disabled", "worker scheduler is active")
        require(worker.get("scheduler_tick_at") is None, "worker scheduler has a live tick")
        require(worker.get("viptel_ws_status") == "disabled", "worker has an active listener")
        if require_fresh_disabled_worker:
            require(worker.get("deployment_version") == release_version, "running worker release mismatch")
            worker_age = (utc_now() - parse_utc(worker.get("heartbeat_at"), "heartbeat_at")).total_seconds()
            require(-5 <= worker_age <= 90, "running worker heartbeat is stale")

    listener = by_instance.get("motorist-prod-01-viptel")
    if phase == "disabled":
        if require_fresh_disabled_listener:
            require(listener is not None, "running disabled listener heartbeat is missing")
        if listener is not None:
            require(listener.get("scheduler_status") == "listener", "listener runtime role is invalid")
            require(listener.get("scheduler_tick_at") is None, "listener has a scheduler tick")
            require(listener.get("viptel_ws_status") == "disabled", "another VIPTel listener is active")
            if require_fresh_disabled_listener:
                require(
                    listener.get("deployment_version") == release_version,
                    "running disabled listener release mismatch",
                )
                listener_age = (
                    utc_now() - parse_utc(listener.get("heartbeat_at"), "heartbeat_at")
                ).total_seconds()
                require(-5 <= listener_age <= 90, "running disabled listener heartbeat is stale")
        return

    require(listener is not None, "VIPTel listener heartbeat is missing")
    require(listener.get("deployment_version") == release_version, "VIPTel listener release mismatch")
    heartbeat_age = (utc_now() - parse_utc(listener.get("heartbeat_at"), "heartbeat_at")).total_seconds()
    require(-5 <= heartbeat_age <= 90, "VIPTel listener heartbeat is stale")
    require(listener.get("scheduler_status") == "listener", "VIPTel listener runtime role is invalid")
    require(listener.get("scheduler_tick_at") is None, "VIPTel listener has a scheduler tick")
    require(listener.get("viptel_ws_status") == "connected", "VIPTel listener is not connected")


def listener_only_state(args: argparse.Namespace) -> None:
    production_dir = require_safe_directory(Path(args.production_dir))
    manifest = load_manifest(production_dir)
    require(manifest["version"] == args.release_version, "release changed before listener state check")
    listener, _ = load_listener_activation_runtime(
        production_dir,
        args.release_version,
        expected_enabled=args.phase == "started",
        require_authority=args.phase == "started",
    )
    deadline = time.monotonic() + args.wait_seconds
    last_error: SystemExit | None = None
    while True:
        try:
            controls = fetch_controls(listener)
            require(not any(controls.values()), "a target job control is enabled")
            validate_listener_only_heartbeat_rows(
                fetch_heartbeats(listener),
                args.release_version,
                args.phase,
                args.require_fresh_disabled_worker,
                args.require_fresh_disabled_listener,
            )
            return
        except SystemExit as error:
            last_error = error
            if time.monotonic() >= deadline:
                raise last_error
            time.sleep(2)


def validate_handover_heartbeat_rows(
    rows: object,
    worker_version: str,
    listener_version: str,
    listener_not_before_utc: str | None = None,
) -> None:
    require(isinstance(rows, list), "target heartbeat response is invalid")
    by_instance: dict[str, dict[str, Any]] = {}
    allowed_instances = {"motorist-prod-01", "motorist-prod-01-viptel"}
    for row in rows:
        require(isinstance(row, dict), "target heartbeat row is invalid")
        instance = row.get("instance_id")
        require(instance in allowed_instances, "an unexpected runtime heartbeat exists")
        require(instance not in by_instance, "target heartbeat identity is duplicated")
        by_instance[instance] = row
    require(set(by_instance) == allowed_instances, "a handover runtime heartbeat is missing")

    worker = by_instance["motorist-prod-01"]
    listener = by_instance["motorist-prod-01-viptel"]
    for row in (worker, listener):
        age = (utc_now() - parse_utc(row.get("heartbeat_at"), "heartbeat_at")).total_seconds()
        require(-5 <= age <= 90, "handover runtime heartbeat is stale")
    require(worker.get("deployment_version") == worker_version, "handover worker release changed")
    require(worker.get("scheduler_status") == "running", "handover worker scheduler is not running")
    scheduler_tick = parse_utc(worker.get("scheduler_tick_at"), "scheduler_tick_at")
    scheduler_tick_age = (utc_now() - scheduler_tick).total_seconds()
    require(-5 <= scheduler_tick_age <= 90, "handover worker scheduler tick is stale")
    require(worker.get("viptel_ws_status") == "disabled", "worker has an active VIPTel listener")

    require(
        listener.get("deployment_version") == listener_version,
        "handover VIPTel listener release mismatch",
    )
    require(listener.get("scheduler_status") == "listener", "handover listener role is invalid")
    require(listener.get("scheduler_tick_at") is None, "handover listener has a scheduler tick")
    require(listener.get("viptel_ws_status") == "connected", "handover listener is not connected")
    if listener_not_before_utc is not None:
        listener_not_before = parse_utc(
            listener_not_before_utc,
            "listener_not_before_utc",
        )
        listener_heartbeat = parse_utc(listener.get("heartbeat_at"), "heartbeat_at")
        require(
            listener_heartbeat > listener_not_before,
            "handover listener heartbeat predates the required boundary",
        )


def handover_state(args: argparse.Namespace) -> None:
    require(args.jobs == "telephony.viptel.reconcile", "handover preserved-job set is not approved")
    if args.listener_not_before_utc is not None:
        parse_utc(args.listener_not_before_utc, "listener_not_before_utc")
    env = load_live_env(args.production_dir, args.release_version)
    deadline = time.monotonic() + args.wait_seconds
    last_error: SystemExit | None = None
    while True:
        try:
            controls = fetch_controls(env)
            enabled = {job for job, is_enabled in controls.items() if is_enabled}
            require(
                enabled == {"telephony.viptel.reconcile"},
                "handover enabled-job set changed",
            )
            validate_handover_heartbeat_rows(
                fetch_heartbeats(env),
                args.worker_version,
                args.listener_version,
                args.listener_not_before_utc,
            )
            return
        except SystemExit as error:
            last_error = error
            if time.monotonic() >= deadline:
                raise last_error
            time.sleep(2)


def validate_heartbeat_rows(
    rows: object,
    release_version: str,
    require_listener: bool,
) -> None:
    require(isinstance(rows, list), "target heartbeat response is invalid")
    by_instance: dict[str, dict[str, Any]] = {}
    allowed_instances = {"motorist-prod-01", "motorist-prod-01-viptel"}
    for row in rows:
        require(isinstance(row, dict), "target heartbeat row is invalid")
        instance = row.get("instance_id")
        parse_utc(row.get("heartbeat_at"), "heartbeat_at")
        require(instance in allowed_instances, "an unexpected runtime heartbeat exists")
        require(instance not in by_instance, "target heartbeat identity is duplicated")
        by_instance[instance] = row
    required = {"motorist-prod-01"}
    if require_listener:
        required.add("motorist-prod-01-viptel")
    require(required <= set(by_instance), "a required runtime heartbeat is missing")
    for instance in required:
        row = by_instance[instance]
        require(row.get("deployment_version") == release_version, "runtime heartbeat release mismatch")
        age = (utc_now() - parse_utc(row.get("heartbeat_at"), "heartbeat_at")).total_seconds()
        require(-5 <= age <= 90, "runtime heartbeat is stale")
    require(
        by_instance["motorist-prod-01"].get("scheduler_status") == "running",
        "worker scheduler heartbeat is not running",
    )
    scheduler_tick_at = parse_utc(
        by_instance["motorist-prod-01"].get("scheduler_tick_at"),
        "scheduler_tick_at",
    )
    scheduler_tick_age = (utc_now() - scheduler_tick_at).total_seconds()
    require(-5 <= scheduler_tick_age <= 90, "worker scheduler tick is stale")
    if require_listener:
        require(
            by_instance["motorist-prod-01-viptel"].get("viptel_ws_status") == "connected",
            "VIPTel listener heartbeat is not connected",
        )
    elif "motorist-prod-01-viptel" in by_instance:
        require(
            by_instance["motorist-prod-01-viptel"].get("scheduler_status") == "listener"
            and by_instance["motorist-prod-01-viptel"].get("viptel_ws_status") == "disabled",
            "VIPTel listener is active without approval",
        )


def fetch_heartbeats(env: dict[str, str]) -> object:
    query = urllib.parse.urlencode(
        {
            "select": "instance_id,deployment_version,heartbeat_at,scheduler_tick_at,scheduler_status,viptel_ws_status",
        }
    )
    return rest_request(env, "GET", f"motorist_worker_status?{query}")


def validate_public_https(release_version: str) -> None:
    expected = {
        "live": "live",
        "ready": "ready",
    }
    for endpoint, expected_status in expected.items():
        url = f"https://dispecing.linkapomoci.sk/api/health/{endpoint}"
        request = urllib.request.Request(
            url,
            headers={"Accept": "application/json", "Cache-Control": "no-cache"},
        )
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                require(response.status == 200, "production HTTPS health check failed")
                require(response.geturl() == url, "production HTTPS health check redirected")
                payload_bytes = response.read(16 * 1024 + 1)
        except (OSError, urllib.error.URLError, urllib.error.HTTPError) as error:
            raise SystemExit("production HTTPS health check failed") from error
        require(len(payload_bytes) <= 16 * 1024, "production HTTPS health response is too large")
        try:
            payload = json.loads(payload_bytes)
        except json.JSONDecodeError as error:
            raise SystemExit("production HTTPS health response is invalid") from error
        require(isinstance(payload, dict), "production HTTPS health response is invalid")
        require(payload.get("status") == expected_status, "production HTTPS health status mismatch")
        require(payload.get("version") == release_version, "production HTTPS release mismatch")


def live_state(args: argparse.Namespace) -> None:
    jobs = parse_jobs(args.jobs, allow_empty=True)
    env = load_live_env(args.production_dir, args.release_version)
    deadline = time.monotonic() + args.wait_seconds
    last_error: SystemExit | None = None
    while True:
        try:
            if args.phase == "disabled":
                validate_public_https(args.release_version)
            controls = fetch_controls(env)
            expected_enabled = set(jobs) if args.phase == "enabled" else set()
            actual_enabled = {job for job, enabled in controls.items() if enabled}
            require(actual_enabled == expected_enabled, "target enabled-job set is not exact")
            if args.phase in ("started", "enabled"):
                validate_heartbeat_rows(
                    fetch_heartbeats(env),
                    args.release_version,
                    args.require_listener,
                )
            return
        except SystemExit as error:
            last_error = error
            if time.monotonic() >= deadline:
                raise last_error
            time.sleep(2)


def receipt_record(args: argparse.Namespace) -> dict[str, Any]:
    jobs = parse_jobs(args.jobs, allow_empty=args.listener == "true")
    require(RELEASE_PATTERN.fullmatch(args.release_version) is not None, "receipt release invalid")
    require(args.image == f"motorist-app:{args.release_version}", "receipt image invalid")
    require(IMAGE_ID_PATTERN.fullmatch(args.image_id) is not None, "receipt image ID invalid")
    require(re.fullmatch(r"[0-9a-f]{64}", args.cutover_sha256) is not None, "cutover binding invalid")
    require(re.fullmatch(r"[0-9a-f]{64}", args.gate_sha256) is not None, "gate binding invalid")
    try:
        one_shot_bindings = json.loads(args.one_shot_bindings_json)
    except json.JSONDecodeError as error:
        raise SystemExit("one-shot receipt binding is invalid") from error
    require(isinstance(one_shot_bindings, list), "one-shot receipt binding is invalid")
    expected_binding_jobs = sorted(jobs + (["telephony.viptel.listener"] if args.listener == "true" else []))
    require(
        [binding.get("job") for binding in one_shot_bindings if isinstance(binding, dict)]
        == expected_binding_jobs,
        "one-shot receipt binding set is not exact",
    )
    for binding in one_shot_bindings:
        require(
            isinstance(binding, dict) and set(binding) == {"job", "sha256s"},
            "one-shot receipt binding is invalid",
        )
        hashes = binding.get("sha256s")
        expected_count = 1 if binding.get("job") == "telephony.viptel.listener" else 2
        require(
            isinstance(hashes, list)
            and len(hashes) == expected_count
            and all(
                isinstance(value, str)
                and re.fullmatch(r"[0-9a-f]{64}", value) is not None
                for value in hashes
            )
            and len(set(hashes)) == expected_count,
            "one-shot receipt binding is invalid",
        )
    return {
        "activation_receipt_schema_version": 1,
        "previous_record_sha256": None,
        "recorded_at_utc": utc_now().strftime("%Y-%m-%dT%H:%M:%SZ"),
        "status": args.status,
        "stage": args.stage,
        "release_version": args.release_version,
        "image": args.image,
        "image_id": args.image_id,
        "target_project_ref": TARGET_REF,
        "jobs": jobs,
        "viptel_listener_enabled": args.listener == "true",
        "cutover_receipt_sha256": args.cutover_sha256,
        "activation_gate_sha256": args.gate_sha256,
        "one_shot_receipts": one_shot_bindings,
    }


def write_receipt(args: argparse.Namespace) -> None:
    path = Path(args.path)
    record = receipt_record(args)
    nofollow = getattr(os, "O_NOFOLLOW", 0)
    if args.mode == "create":
        require(
            args.status == "in_progress" and args.stage == "activation_started",
            "activation receipt must start in progress",
        )
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | nofollow, 0o600)
        mode = "wb"
    else:
        require(args.status in ("success", "failure"), "activation receipt terminal status invalid")
        descriptor = os.open(path, os.O_RDWR | os.O_APPEND | nofollow)
        mode = "r+b"
    with os.fdopen(descriptor, mode) as output:
        metadata = os.fstat(output.fileno())
        require(stat.S_ISREG(metadata.st_mode), "activation receipt is not regular")
        require(metadata.st_nlink == 1, "activation receipt has multiple links")
        require(stat.S_IMODE(metadata.st_mode) == 0o600, "activation receipt is not private")
        if args.mode == "append":
            output.seek(0)
            contents = output.read()
            require(contents.endswith(b"\n"), "activation receipt is incomplete")
            lines = contents.splitlines(keepends=True)
            require(len(lines) == 1, "activation receipt already has a terminal record")
            try:
                first = json.loads(lines[0])
            except json.JSONDecodeError as error:
                raise SystemExit("activation receipt initial record is invalid") from error
            identity = (
                "release_version",
                "image",
                "image_id",
                "target_project_ref",
                "jobs",
                "viptel_listener_enabled",
                "cutover_receipt_sha256",
                "activation_gate_sha256",
                "one_shot_receipts",
            )
            require(
                first.get("status") == "in_progress"
                and first.get("stage") == "activation_started",
                "activation receipt initial record is invalid",
            )
            require(
                all(first.get(key) == record.get(key) for key in identity),
                "activation receipt identity mismatch",
            )
            record["previous_record_sha256"] = hashlib.sha256(lines[0]).hexdigest()
        payload = (json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n").encode(
            "utf-8"
        )
        output.write(payload)
        output.flush()
        os.fsync(output.fileno())


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(add_help=True)
    subparsers = parser.add_subparsers(dest="command", required=True)

    check = subparsers.add_parser("preflight")
    check.add_argument("production_dir")
    check.add_argument("cutover_receipt")
    check.add_argument("activation_gate")
    check.add_argument("one_shot_receipt_dir")
    check.add_argument("--activation-script-dir", required=True)
    check.add_argument("--jobs", required=True)
    check.add_argument("--enable-viptel-listener", action="store_true")
    check.add_argument("--output", choices=("json", "lines"), default="json")
    check.set_defaults(handler=preflight)

    gate_check = subparsers.add_parser("revalidate-gate")
    gate_check.add_argument("production_dir")
    gate_check.add_argument("release_version")
    gate_check.add_argument("cutover_receipt")
    gate_check.add_argument("activation_gate")
    gate_check.add_argument("--activation-script-dir", required=True)
    gate_check.add_argument("--expected-cutover-sha256", required=True)
    gate_check.add_argument("--expected-gate-sha256", required=True)
    gate_check.set_defaults(handler=revalidate_gate)

    flags = subparsers.add_parser("set-flags")
    flags.add_argument("production_dir")
    flags.add_argument("release_version")
    flags.add_argument("--scheduler", choices=("true", "false"), required=True)
    flags.add_argument("--listener", choices=("true", "false"), required=True)
    flags.add_argument("--expected-worker-sha256")
    flags.add_argument("--expected-listener-sha256")
    flags.add_argument("--force-disable", action="store_true")
    flags.add_argument("--output", choices=("none", "lines"), default="none")
    flags.set_defaults(handler=set_flags)

    listener_flags = subparsers.add_parser("set-listener-flags")
    listener_flags.add_argument("production_dir")
    listener_flags.add_argument("release_version")
    listener_flags.add_argument("--enabled", choices=("true", "false"), required=True)
    listener_flags.add_argument("--expected-listener-sha256")
    listener_flags.add_argument("--force-disable", action="store_true")
    listener_flags.add_argument("--output", choices=("none", "hash"), default="none")
    listener_flags.set_defaults(handler=set_listener_flags)

    listener_verify = subparsers.add_parser("verify-listener-runtime")
    listener_verify.add_argument("production_dir")
    listener_verify.add_argument("release_version")
    listener_verify.add_argument("--expected-listener-sha256", required=True)
    listener_verify.add_argument("--enabled", choices=("true", "false"), required=True)
    listener_verify.add_argument("--require-authority", action="store_true")
    listener_verify.set_defaults(handler=verify_listener_runtime)

    listener_release = subparsers.add_parser("verify-listener-release")
    listener_release.add_argument("production_dir")
    listener_release.add_argument("release_version")
    listener_release.add_argument("--expected-git-sha", required=True)
    listener_release.add_argument("--expected-release-sha256")
    listener_release.set_defaults(handler=verify_listener_release)

    handover_release = subparsers.add_parser("verify-handover-release")
    handover_release.add_argument("production_dir")
    handover_release.add_argument("release_version")
    handover_release.add_argument("--expected-git-sha", required=True)
    handover_release.add_argument("--expected-release-sha256", required=True)
    handover_release.set_defaults(handler=verify_handover_release)

    handover_old_runtime = subparsers.add_parser("verify-handover-old-runtime")
    handover_old_runtime.add_argument("production_dir")
    handover_old_runtime.add_argument("release_version")
    handover_old_runtime.add_argument("--expected-worker-sha256", required=True)
    handover_old_runtime.add_argument("--expected-listener-sha256", required=True)
    handover_old_runtime.set_defaults(handler=verify_handover_old_runtime)

    handover_worker_runtime = subparsers.add_parser("verify-handover-worker-runtime")
    handover_worker_runtime.add_argument("production_dir")
    handover_worker_runtime.add_argument("release_version")
    handover_worker_runtime.add_argument("--expected-worker-sha256", required=True)
    handover_worker_runtime.set_defaults(handler=verify_handover_worker_runtime)

    handover_listener_runtime = subparsers.add_parser("verify-handover-listener-runtime")
    handover_listener_runtime.add_argument("production_dir")
    handover_listener_runtime.add_argument("release_version")
    handover_listener_runtime.add_argument("--expected-listener-sha256", required=True)
    handover_listener_runtime.add_argument("--enabled", choices=("true", "false"), required=True)
    handover_listener_runtime.set_defaults(handler=verify_handover_listener_runtime)

    handover_new_runtime = subparsers.add_parser("verify-handover-new-runtime")
    handover_new_runtime.add_argument("production_dir")
    handover_new_runtime.add_argument("release_version")
    handover_new_runtime.add_argument("--expected-listener-sha256", required=True)
    handover_new_runtime.add_argument("--enabled", choices=("true", "false"), required=True)
    handover_new_runtime.set_defaults(handler=verify_handover_new_runtime)

    handover_stage_runtime = subparsers.add_parser("verify-handover-stage-runtime")
    handover_stage_runtime.add_argument("production_dir")
    handover_stage_runtime.add_argument("release_version")
    handover_stage_runtime.set_defaults(handler=verify_handover_stage_runtime)

    handover_flags = subparsers.add_parser("set-handover-listener-flags")
    handover_flags.add_argument("production_dir")
    handover_flags.add_argument("release_version")
    handover_flags.add_argument("--enabled", choices=("true", "false"), required=True)
    handover_flags.add_argument("--expected-listener-sha256")
    handover_flags.add_argument("--force-disable", action="store_true")
    handover_flags.add_argument("--output", choices=("none", "hash"), default="none")
    handover_flags.set_defaults(handler=set_handover_listener_flags)

    verify = subparsers.add_parser("verify-runtime")
    verify.add_argument("production_dir")
    verify.add_argument("release_version")
    verify.add_argument("--expected-worker-sha256", required=True)
    verify.add_argument("--expected-listener-sha256", required=True)
    verify.set_defaults(handler=verify_runtime)

    controls = subparsers.add_parser("set-controls")
    controls.add_argument("production_dir")
    controls.add_argument("release_version")
    controls.add_argument("--jobs", default="")
    controls.add_argument("--mode", choices=("enable", "disable", "disable-all"), required=True)
    controls.set_defaults(handler=set_controls)

    control_state = subparsers.add_parser("controls-state")
    control_state.add_argument("production_dir")
    control_state.add_argument("release_version")
    control_state.add_argument("--jobs", default="")
    control_state.set_defaults(handler=controls_state)

    state = subparsers.add_parser("live-state")
    state.add_argument("production_dir")
    state.add_argument("release_version")
    state.add_argument("--jobs", default="")
    state.add_argument("--phase", choices=("disabled", "started", "enabled"), required=True)
    state.add_argument("--require-listener", action="store_true")
    state.add_argument("--wait-seconds", type=int, choices=range(0, 181), default=0)
    state.set_defaults(handler=live_state)

    listener_state = subparsers.add_parser("listener-only-state")
    listener_state.add_argument("production_dir")
    listener_state.add_argument("release_version")
    listener_state.add_argument("--phase", choices=("disabled", "started"), required=True)
    listener_state.add_argument("--wait-seconds", type=int, choices=range(0, 181), default=0)
    listener_state.add_argument("--require-fresh-disabled-worker", action="store_true")
    listener_state.add_argument("--require-fresh-disabled-listener", action="store_true")
    listener_state.set_defaults(handler=listener_only_state)

    handover_runtime_state = subparsers.add_parser("handover-state")
    handover_runtime_state.add_argument("production_dir")
    handover_runtime_state.add_argument("release_version")
    handover_runtime_state.add_argument("--worker-version", required=True)
    handover_runtime_state.add_argument("--listener-version", required=True)
    handover_runtime_state.add_argument("--jobs", required=True)
    handover_runtime_state.add_argument("--listener-not-before-utc")
    handover_runtime_state.add_argument("--wait-seconds", type=int, choices=range(0, 181), default=0)
    handover_runtime_state.set_defaults(handler=handover_state)

    receipt = subparsers.add_parser("receipt")
    receipt.add_argument("path")
    receipt.add_argument("--mode", choices=("create", "append"), required=True)
    receipt.add_argument("--status", choices=("in_progress", "success", "failure"), required=True)
    receipt.add_argument(
        "--stage",
        choices=(
            "activation_started",
            "activation_complete",
            "rollback_complete",
            "rollback_incomplete",
        ),
        required=True,
    )
    receipt.add_argument("--release-version", required=True)
    receipt.add_argument("--image", required=True)
    receipt.add_argument("--image-id", required=True)
    receipt.add_argument("--jobs", required=True)
    receipt.add_argument("--listener", choices=("true", "false"), required=True)
    receipt.add_argument("--cutover-sha256", required=True)
    receipt.add_argument("--gate-sha256", required=True)
    receipt.add_argument("--one-shot-bindings-json", required=True)
    receipt.set_defaults(handler=write_receipt)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    args.handler(args)


if __name__ == "__main__":
    main()
