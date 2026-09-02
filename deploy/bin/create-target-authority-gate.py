#!/usr/bin/env python3

"""Create the minimal read-only gate for the Frankfurt-authoritative cutover."""

from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import hashlib
import json
import os
import re
import stat
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path, PurePosixPath
from typing import Any, Callable


SOURCE_REF = "jcwbiulwuwyrnmzjjbgr"
TARGET_REF = "sjcsrygkkmersoczpunh"
TARGET_URL = f"https://{TARGET_REF}.supabase.co"
APP_ORIGIN = "https://dispecing.linkapomoci.sk"
APP_DOMAIN = "dispecing.linkapomoci.sk"
MANAGEMENT_ORIGIN = "https://api.supabase.com"
MAX_SMALL_FILE_BYTES = 1024 * 1024
MAX_API_RESPONSE_BYTES = 64 * 1024
MAX_VALIDATION_SECONDS = 120
MAX_GATE_AGE_SECONDS = 30 * 60
MAX_AGGREGATE_EVIDENCE_BYTES = 16 * 1024
MAX_AGGREGATE_EVIDENCE_AGE_SECONDS = 120
AGGREGATE_EVIDENCE_SCHEMA = "motorist-target-authority-aggregate-evidence/v1"
AGGREGATE_EVIDENCE_STATUS = "pass_read_only"
EXPECTED_JOBS = (
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
BUILD_ARGUMENT_KEYS = (
    "DEPLOYMENT_VERSION",
    "NEXT_PUBLIC_APP_URL",
    "NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY",
    "NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    "NEXT_PUBLIC_SUPABASE_URL",
)
REQUIRED_RELEASE_FILES = frozenset(
    {
        "image.tar.gz",
        "manifest.json",
        "compose.yml",
        "Caddyfile",
        "upstream.caddy",
    }
)
RELEASE_PATTERN = re.compile(r"hetzner-[A-Za-z0-9][A-Za-z0-9._-]{0,95}")
SHA256_PATTERN = re.compile(r"[0-9a-f]{64}")
IMAGE_ID_PATTERN = re.compile(r"sha256:[0-9a-f]{64}")
ENV_KEY_PATTERN = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
UTC_PATTERN = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z")


_EXPECTED_JOBS_SQL = ",".join(
    "'" + job.replace("'", "''") + "'" for job in EXPECTED_JOBS
)
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
  (select pg_catalog.count(*)::integer from public.motorist_job_controls)
    as job_controls_total,
  (select pg_catalog.count(*)::integer from public.motorist_job_controls where enabled)
    as job_controls_enabled,
  (select pg_catalog.count(*)::integer
     from public.motorist_job_controls
    where job_name = any(array[{_EXPECTED_JOBS_SQL}]::text[]))
    as expected_job_controls_total;"""
SOURCE_QUERY_SHA256 = hashlib.sha256(SOURCE_STATE_QUERY.encode("utf-8")).hexdigest()
TARGET_QUERY_SHA256 = hashlib.sha256(TARGET_STATE_QUERY.encode("utf-8")).hexdigest()
ALLOWED_EVIDENCE_TRANSPORT = {
    SOURCE_REF: ("supabase_management_api", "database/query"),
    TARGET_REF: ("supabase_dispatch_prod", "execute_sql"),
}


class GateError(Exception):
    """A validation failure safe to report without input values."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise GateError(message)


def format_utc(value: dt.datetime) -> str:
    return value.astimezone(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_utc(value: object, field: str) -> dt.datetime:
    require(
        isinstance(value, str) and UTC_PATTERN.fullmatch(value) is not None,
        f"aggregate evidence {field} is not a strict UTC timestamp",
    )
    try:
        return dt.datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(
            tzinfo=dt.timezone.utc
        )
    except ValueError as error:
        raise GateError(f"aggregate evidence {field} is invalid") from error


def canonical_commitment(field: str, evidence: dict[str, Any]) -> str:
    payload = json.dumps(
        {
            "schema": "target-authority/compatibility-commitment-v1",
            "field": field,
            "evidence": evidence,
        },
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
    ).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def require_directory(path: Path, *, private: bool = False) -> Path:
    absolute = Path(os.path.abspath(path))
    require(os.path.realpath(absolute) == str(absolute), "directory traverses a symlink")
    try:
        metadata = os.lstat(absolute)
    except OSError as error:
        raise GateError("required directory is unavailable") from error
    require(stat.S_ISDIR(metadata.st_mode), "required path is not a directory")
    if private:
        require(stat.S_IMODE(metadata.st_mode) & 0o077 == 0, "private directory permissions are unsafe")
    return absolute


def read_regular(path: Path, *, private: bool = False, maximum_size: int | None = MAX_SMALL_FILE_BYTES) -> bytes:
    absolute = Path(os.path.abspath(path))
    require(os.path.realpath(absolute) == str(absolute), "input file traverses a symlink")
    try:
        before = os.lstat(absolute)
    except OSError as error:
        raise GateError("required input file is unavailable") from error
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1, "input is not a unique regular file")
    if private:
        require(stat.S_IMODE(before.st_mode) & 0o077 == 0, "private input permissions are unsafe")
    if maximum_size is not None:
        require(before.st_size <= maximum_size, "input file is too large")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(absolute, flags)
    except OSError as error:
        raise GateError("required input file cannot be opened safely") from error
    try:
        opened = os.fstat(descriptor)
        require(
            (
                opened.st_dev,
                opened.st_ino,
                opened.st_size,
                opened.st_mtime_ns,
                opened.st_mode,
                opened.st_uid,
                opened.st_gid,
                opened.st_nlink,
            )
            == (
                before.st_dev,
                before.st_ino,
                before.st_size,
                before.st_mtime_ns,
                before.st_mode,
                before.st_uid,
                before.st_gid,
                before.st_nlink,
            ),
            "input changed while it was opened",
        )
        chunks: list[bytes] = []
        remaining = None if maximum_size is None else maximum_size + 1
        while remaining is None or remaining > 0:
            size = 1024 * 1024 if remaining is None else min(1024 * 1024, remaining)
            chunk = os.read(descriptor, size)
            if not chunk:
                break
            chunks.append(chunk)
            if remaining is not None:
                remaining -= len(chunk)
        payload = b"".join(chunks)
        if maximum_size is not None:
            require(len(payload) <= maximum_size, "input file is too large")
        after = os.fstat(descriptor)
        require(
            (
                after.st_size,
                after.st_mtime_ns,
                after.st_mode,
                after.st_uid,
                after.st_gid,
                after.st_nlink,
            )
            == (
                opened.st_size,
                opened.st_mtime_ns,
                opened.st_mode,
                opened.st_uid,
                opened.st_gid,
                opened.st_nlink,
            ),
            "input changed while it was read",
        )
        return payload
    finally:
        os.close(descriptor)


def sha256_file(path: Path) -> str:
    absolute = Path(os.path.abspath(path))
    require(os.path.realpath(absolute) == str(absolute), "release file traverses a symlink")
    try:
        before = os.lstat(absolute)
        descriptor = os.open(absolute, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except OSError as error:
        raise GateError("release file cannot be opened safely") from error
    require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1, "release entry is not a unique regular file")
    digest = hashlib.sha256()
    try:
        opened = os.fstat(descriptor)
        require(
            (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns)
            == (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns),
            "release file changed while it was opened",
        )
        while True:
            chunk = os.read(descriptor, 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
        after = os.fstat(descriptor)
        require(
            (after.st_size, after.st_mtime_ns) == (opened.st_size, opened.st_mtime_ns),
            "release file changed while it was hashed",
        )
    finally:
        os.close(descriptor)
    return digest.hexdigest()


def read_json(path: Path, *, private: bool = False) -> tuple[dict[str, Any], bytes]:
    payload = read_regular(path, private=private)
    try:
        value = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise GateError("JSON input is invalid") from error
    require(isinstance(value, dict), "JSON input must be an object")
    return value, payload


def parse_env(path: Path, *, required_keys: tuple[str, ...]) -> tuple[dict[str, str], str]:
    payload = read_regular(path, private=True, maximum_size=256 * 1024)
    try:
        contents = payload.decode("utf-8")
    except UnicodeDecodeError as error:
        raise GateError("environment input is not UTF-8") from error
    require(contents.endswith("\n"), "environment input is incomplete")
    values: dict[str, str] = {}
    for line in contents.splitlines():
        if not line:
            continue
        require("=" in line, "environment input contains a malformed line")
        key, encoded = line.split("=", 1)
        require(ENV_KEY_PATTERN.fullmatch(key) is not None, "environment key is invalid")
        require(key not in values, "environment input contains a duplicate key")
        if encoded.startswith('"'):
            try:
                value = json.loads(encoded)
            except json.JSONDecodeError as error:
                raise GateError("environment value quoting is invalid") from error
            require(isinstance(value, str), "environment value must be a string")
        elif encoded.startswith("'"):
            require(
                len(encoded) >= 2 and encoded.endswith("'") and "'" not in encoded[1:-1],
                "environment value quoting is invalid",
            )
            value = encoded[1:-1]
        else:
            require(
                not any(character.isspace() or ord(character) < 32 for character in encoded),
                "environment value contains unsafe characters",
            )
            value = encoded
        require("\0" not in value, "environment value contains a null byte")
        values[key] = value
    require(all(values.get(key) for key in required_keys), "environment input is incomplete")
    return values, hashlib.sha256(payload).hexdigest()


def validate_manifest(manifest: dict[str, Any]) -> None:
    version = manifest.get("version")
    require(isinstance(version, str) and RELEASE_PATTERN.fullmatch(version) is not None, "release version is invalid")
    require(".." not in version, "release version is invalid")
    require(manifest.get("image") == f"motorist-app:{version}", "release image name is invalid")
    require(isinstance(manifest.get("imageId"), str) and IMAGE_ID_PATTERN.fullmatch(manifest["imageId"]), "release image ID is invalid")
    require(isinstance(manifest.get("gitSha"), str) and re.fullmatch(r"[0-9a-f]{40}", manifest["gitSha"]), "release git SHA is invalid")
    for key in ("buildContextSha256", "buildArgsSha256"):
        require(isinstance(manifest.get(key), str) and SHA256_PATTERN.fullmatch(manifest[key]), f"release {key} is invalid")
    require(manifest.get("platform") == "linux/amd64", "release platform is invalid")
    require(manifest.get("schedulerEnabled") is False, "release scheduler must be disabled")


def validate_release(release_arg: Path) -> tuple[dict[str, Any], dict[str, str]]:
    release = require_directory(release_arg)
    require_directory(release / "bin")
    sums_payload = read_regular(release / "SHA256SUMS")
    try:
        sums_text = sums_payload.decode("ascii")
    except UnicodeDecodeError as error:
        raise GateError("SHA256SUMS is not ASCII") from error
    require(sums_text.endswith("\n"), "SHA256SUMS is incomplete")
    checksums: dict[str, str] = {}
    for line in sums_text.splitlines():
        match = re.fullmatch(r"([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._/-]*)", line)
        require(match is not None, "SHA256SUMS contains an invalid entry")
        expected, name = match.groups()
        pure = PurePosixPath(name)
        require(not pure.is_absolute() and "." not in pure.parts and ".." not in pure.parts, "SHA256SUMS path escapes the release")
        require(name not in checksums, "SHA256SUMS contains a duplicate entry")
        checksums[name] = expected
    require(REQUIRED_RELEASE_FILES.issubset(checksums), "SHA256SUMS does not cover the minimal release")
    for name, expected in checksums.items():
        actual = sha256_file(release / Path(*PurePosixPath(name).parts))
        require(actual == expected, "release checksum verification failed")
    manifest, manifest_payload = read_json(release / "manifest.json")
    validate_manifest(manifest)
    require(hashlib.sha256(manifest_payload).hexdigest() == checksums["manifest.json"], "manifest checksum is invalid")
    return manifest, {
        "manifest": checksums["manifest.json"],
        "image_archive": checksums["image.tar.gz"],
        "sha256sums": hashlib.sha256(sums_payload).hexdigest(),
    }


def validate_build_contract(path: Path, manifest: dict[str, Any], web_env: dict[str, str]) -> str:
    contract, payload = read_json(path, private=True)
    digest = hashlib.sha256(payload).hexdigest()
    require(digest == manifest["buildArgsSha256"], "build-input contract does not match the release")
    require(contract.get("schemaVersion") == 1 and isinstance(contract.get("buildArgs"), dict), "build-input contract schema is invalid")
    build_args = contract["buildArgs"]
    require(tuple(sorted(build_args)) == BUILD_ARGUMENT_KEYS, "build-input contract keys are invalid")
    require(all(isinstance(value, str) and not any(character in value for character in "\r\n\0") for value in build_args.values()), "build-input contract value is invalid")
    require(build_args["DEPLOYMENT_VERSION"] == manifest["version"], "build release identity differs")
    require(build_args["NEXT_PUBLIC_APP_URL"] == APP_ORIGIN, "build app origin differs")
    require(build_args["NEXT_PUBLIC_SUPABASE_URL"] == TARGET_URL, "build does not use the target project")
    require(SOURCE_REF not in payload.decode("utf-8"), "build input contains the source project")
    for key in ("NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY"):
        require(build_args[key] == web_env.get(key), "build and runtime public inputs differ")
    require(build_args["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"] != "", "build publishable key is missing")
    require(build_args["NEXT_PUBLIC_SUPABASE_ANON_KEY"] == build_args["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"], "build public key aliases differ")
    return digest


def validate_runtime(runtime_arg: Path, manifest: dict[str, Any]) -> tuple[dict[str, dict[str, str]], dict[str, str]]:
    runtime = require_directory(runtime_arg, private=True)
    envs: dict[str, dict[str, str]] = {}
    digests: dict[str, str] = {}
    for name in ("web", "worker", "viptel-listener", "caddy"):
        values, digest = parse_env(runtime / f"{name}.env", required_keys=())
        envs[name] = values
        digests[name.replace("-", "_")] = digest
        require(all(SOURCE_REF not in value for value in values.values()), "runtime contains the source project")
    for name in ("web", "worker", "viptel-listener"):
        env = envs[name]
        for key in ("SUPABASE_PROJECT_REF", "SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "DEPLOYMENT_VERSION", "NODE_ENV", "MOTORIST_DEV_AUTH_BYPASS"):
            require(env.get(key), "runtime contract is incomplete")
        require(env["SUPABASE_PROJECT_REF"] == TARGET_REF, "runtime project ref differs")
        require(env["SUPABASE_URL"] == TARGET_URL and env["NEXT_PUBLIC_SUPABASE_URL"] == TARGET_URL, "runtime Supabase URL differs")
        require(env["DEPLOYMENT_VERSION"] == manifest["version"], "runtime release version differs")
        require(env["NODE_ENV"] == "production" and env["MOTORIST_DEV_AUTH_BYPASS"] == "false", "runtime safety mode is invalid")
        require(env.get("APP_BASE_URL") == APP_ORIGIN and env.get("PUBLIC_APP_URL") == APP_ORIGIN, "runtime app origin differs")
        public_keys = ("NEXT_PUBLIC_SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "SUPABASE_ANON_KEY", "SUPABASE_PUBLISHABLE_KEY")
        secret_keys = ("SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY")
        require(all(env.get(key) for key in (*public_keys, *secret_keys)), "runtime Supabase keys are incomplete")
        require(len({env[key] for key in public_keys}) == 1, "runtime public key aliases differ")
        require(len({env[key] for key in secret_keys}) == 1, "runtime secret key aliases differ")
        require(env[public_keys[0]] != env[secret_keys[0]], "runtime public and secret keys are not separated")
        require("SUPABASE_JWT_SECRET" not in env and "VERCEL" not in env, "runtime contains a forbidden legacy value")
    require("SCHEDULER_ENABLED" not in envs["web"], "web runtime contains scheduler state")
    require(envs["worker"].get("SCHEDULER_ENABLED") == "false", "worker scheduler is enabled")
    require(envs["viptel-listener"].get("VIPTEL_LISTENER_ENABLED") == "false", "VIPTel listener is enabled")
    require(envs["caddy"].get("APP_DOMAIN") == APP_DOMAIN and bool(envs["caddy"].get("ACME_EMAIL")), "Caddy runtime contract is invalid")
    return envs, digests


def parse_migration_env(path: Path) -> dict[str, str]:
    required = (
        "SOURCE_PROJECT_REF",
        "TARGET_PROJECT_REF",
        "SOURCE_SUPABASE_ACCESS_TOKEN",
        "TARGET_SUPABASE_ACCESS_TOKEN",
    )
    env, _digest = parse_env(path, required_keys=required)
    require(env["SOURCE_PROJECT_REF"] == SOURCE_REF and env["TARGET_PROJECT_REF"] == TARGET_REF, "migration project identity differs")
    for key in ("SOURCE_SUPABASE_ACCESS_TOKEN", "TARGET_SUPABASE_ACCESS_TOKEN"):
        require(20 <= len(env[key]) <= 256 and not any(character.isspace() for character in env[key]), "Management API token format is invalid")
    return env


def parse_aggregate_evidence(
    path: Path,
    *,
    now: dt.datetime | None = None,
) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    absolute = Path(os.path.abspath(path))
    parent = require_directory(absolute.parent, private=True)
    require(parent == absolute.parent, "aggregate evidence parent is invalid")
    try:
        metadata = os.lstat(absolute)
    except OSError as error:
        raise GateError("aggregate evidence file is unavailable") from error
    require(
        stat.S_ISREG(metadata.st_mode)
        and metadata.st_nlink == 1
        and metadata.st_uid == os.geteuid(),
        "aggregate evidence must be an owner-controlled unique regular file",
    )
    require(
        stat.S_IMODE(metadata.st_mode) == 0o600,
        "aggregate evidence must have mode 0600",
    )
    payload = read_regular(
        absolute,
        private=True,
        maximum_size=MAX_AGGREGATE_EVIDENCE_BYTES,
    )

    def reject_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        parsed: dict[str, Any] = {}
        for key, value in pairs:
            if key in parsed:
                raise GateError("aggregate evidence contains a duplicate key")
            parsed[key] = value
        return parsed

    try:
        evidence = json.loads(payload, object_pairs_hook=reject_duplicates)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise GateError("aggregate evidence JSON is invalid") from error
    require(isinstance(evidence, dict), "aggregate evidence must be an object")
    require(
        set(evidence) == {"schema", "status", "generated_at_utc", "source", "target"},
        "aggregate evidence top-level contract is not exact",
    )
    require(evidence["schema"] == AGGREGATE_EVIDENCE_SCHEMA, "aggregate evidence schema is invalid")
    require(evidence["status"] == AGGREGATE_EVIDENCE_STATUS, "aggregate evidence status is invalid")
    generated_at = parse_utc(evidence["generated_at_utc"], "generated_at_utc")
    effective_now = now or dt.datetime.now(dt.timezone.utc)
    require(generated_at <= effective_now, "aggregate evidence timestamp is in the future")
    require(
        0 <= (effective_now - generated_at).total_seconds() <= MAX_AGGREGATE_EVIDENCE_AGE_SECONDS,
        "aggregate evidence is stale",
    )

    source_keys = {
        "status",
        "project_ref",
        "transport",
        "tool",
        "read_only",
        "credential_value_read_or_recorded",
        "query_sha256",
        "observed_at_utc",
        "database_default_read_only",
        "active_cron_jobs",
    }
    target_keys = source_keys | {
        "job_controls_total",
        "job_controls_enabled",
        "expected_job_controls_total",
    }
    source = evidence["source"]
    target = evidence["target"]
    require(isinstance(source, dict) and set(source) == source_keys, "source aggregate evidence contract is not exact")
    require(isinstance(target, dict) and set(target) == target_keys, "target aggregate evidence contract is not exact")

    expected_query_sha = {
        SOURCE_REF: SOURCE_QUERY_SHA256,
        TARGET_REF: TARGET_QUERY_SHA256,
    }
    observations: dict[str, dt.datetime] = {}
    for project_ref, section in ((SOURCE_REF, source), (TARGET_REF, target)):
        require(section["status"] == "pass", "aggregate endpoint evidence status is invalid")
        require(section["project_ref"] == project_ref, "aggregate endpoint project ref is invalid")
        require(
            (section["transport"], section["tool"])
            == ALLOWED_EVIDENCE_TRANSPORT[project_ref],
            "aggregate evidence transport and tool are not allowed",
        )
        require(section["read_only"] is True, "aggregate evidence is not read-only")
        require(
            section["credential_value_read_or_recorded"] is False,
            "aggregate evidence accessed or recorded a credential value",
        )
        require(
            section["query_sha256"] == expected_query_sha[project_ref],
            "aggregate evidence query binding is invalid",
        )
        observed_at = parse_utc(section["observed_at_utc"], "observed_at_utc")
        require(observed_at <= effective_now, "aggregate evidence timestamp is in the future")
        require(observed_at <= generated_at, "aggregate evidence was generated before observation")
        require(
            0 <= (effective_now - observed_at).total_seconds()
            <= MAX_AGGREGATE_EVIDENCE_AGE_SECONDS,
            "aggregate evidence observation is stale",
        )
        observations[project_ref] = observed_at

    source_row = {
        "database_default_read_only": source["database_default_read_only"],
        "active_cron_jobs": source["active_cron_jobs"],
    }
    target_row = {
        "database_default_read_only": target["database_default_read_only"],
        "active_cron_jobs": target["active_cron_jobs"],
        "job_controls_total": target["job_controls_total"],
        "job_controls_enabled": target["job_controls_enabled"],
        "expected_job_controls_total": target["expected_job_controls_total"],
    }
    provenance = {
        "mode": "aggregate_file",
        "schema": AGGREGATE_EVIDENCE_SCHEMA,
        "sha256": hashlib.sha256(payload).hexdigest(),
        "generated_at_utc": format_utc(generated_at),
        "source": {
            "transport": source["transport"],
            "tool": source["tool"],
            "read_only": True,
            "credential_value_read_or_recorded": False,
            "query_sha256": source["query_sha256"],
            "observed_at_utc": format_utc(observations[SOURCE_REF]),
        },
        "target": {
            "transport": target["transport"],
            "tool": target["tool"],
            "read_only": True,
            "credential_value_read_or_recorded": False,
            "query_sha256": target["query_sha256"],
            "observed_at_utc": format_utc(observations[TARGET_REF]),
        },
    }
    return source_row, target_row, provenance


def revalidate_aggregate_evidence_freshness(
    provenance: dict[str, Any],
    *,
    now: dt.datetime,
) -> None:
    if provenance.get("mode") != "aggregate_file":
        return
    timestamps = (
        parse_utc(provenance.get("generated_at_utc"), "generated_at_utc"),
        parse_utc(
            provenance.get("source", {}).get("observed_at_utc"),
            "source observed_at_utc",
        ),
        parse_utc(
            provenance.get("target", {}).get("observed_at_utc"),
            "target observed_at_utc",
        ),
    )
    for timestamp in timestamps:
        require(timestamp <= now, "aggregate evidence timestamp is in the future")
        require(
            0 <= (now - timestamp).total_seconds()
            <= MAX_AGGREGATE_EVIDENCE_AGE_SECONDS,
            "aggregate evidence became stale during gate validation",
        )


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        return None


def fetch_project_state(project_ref: str, token: str) -> dict[str, Any]:
    require(project_ref in (SOURCE_REF, TARGET_REF), "project ref is not allowed")
    query = SOURCE_STATE_QUERY if project_ref == SOURCE_REF else TARGET_STATE_QUERY
    body = json.dumps({"query": query, "read_only": True}).encode("utf-8")
    request = urllib.request.Request(
        f"{MANAGEMENT_ORIGIN}/v1/projects/{project_ref}/database/query",
        data=body,
        method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json", "Accept": "application/json"},
    )
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=20) as response:
            require(response.status == 200, "Management API aggregate query failed")
            payload = response.read(MAX_API_RESPONSE_BYTES + 1)
    except (OSError, urllib.error.URLError, urllib.error.HTTPError) as error:
        raise GateError("Management API aggregate query failed") from error
    require(len(payload) <= MAX_API_RESPONSE_BYTES, "Management API response is too large")
    try:
        rows = json.loads(payload)
    except json.JSONDecodeError as error:
        raise GateError("Management API aggregate response is invalid") from error
    require(isinstance(rows, list) and len(rows) == 1 and isinstance(rows[0], dict), "Management API aggregate response is invalid")
    return rows[0]


def validate_project_states(source: dict[str, Any], target: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    require(type(source.get("database_default_read_only")) is bool and type(source.get("active_cron_jobs")) is int, "source aggregate state is invalid")
    require(source["database_default_read_only"] is True, "source database freeze is inactive")
    require(source["active_cron_jobs"] == 0, "source has active cron jobs")
    required_target = ("database_default_read_only", "active_cron_jobs", "job_controls_total", "job_controls_enabled", "expected_job_controls_total")
    require(type(target.get(required_target[0])) is bool and all(type(target.get(key)) is int for key in required_target[1:]), "target aggregate state is invalid")
    require(target["database_default_read_only"] is False, "target has a persistent read-only default")
    require(target["active_cron_jobs"] == 0, "target has active cron jobs")
    require(target["job_controls_total"] == len(EXPECTED_JOBS) and target["expected_job_controls_total"] == len(EXPECTED_JOBS), "target job-control set is not exact")
    require(target["job_controls_enabled"] == 0, "target has enabled jobs")
    return (
        {"persistent_database_freeze": True, "active_cron_jobs": 0},
        {"writable_default": True, "active_cron_jobs": 0, "job_controls_total": len(EXPECTED_JOBS), "job_controls_enabled": 0},
    )


def request_health(url: str, headers: dict[str, str], expected_statuses: tuple[int, ...]) -> None:
    request = urllib.request.Request(url, method="GET", headers={**headers, "Accept": "application/json", "Cache-Control": "no-cache"})
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=15) as response:
            require(response.status in expected_statuses and response.geturl() == url, "target service health probe failed")
            payload = response.read(MAX_API_RESPONSE_BYTES + 1)
    except (OSError, urllib.error.URLError, urllib.error.HTTPError) as error:
        raise GateError("target service health probe failed") from error
    require(len(payload) <= MAX_API_RESPONSE_BYTES, "target service response is too large")


def probe_target_services(web_env: dict[str, str]) -> dict[str, bool]:
    public_key = web_env["SUPABASE_PUBLISHABLE_KEY"]
    secret_key = web_env["SUPABASE_SECRET_KEY"]
    request_health(f"{TARGET_URL}/auth/v1/settings", {"apikey": public_key}, (200,))
    data_query = urllib.parse.urlencode({"select": "id", "limit": "0"})
    privileged = {"apikey": secret_key, "Authorization": f"Bearer {secret_key}"}
    request_health(f"{TARGET_URL}/rest/v1/motorist_profiles?{data_query}", privileged, (200, 206))
    request_health(f"{TARGET_URL}/storage/v1/bucket", privileged, (200,))
    return {"auth": True, "data_api": True, "storage": True}


def write_private_exclusive(path: Path, payload: bytes) -> None:
    parent = require_directory(path.parent, private=True)
    output = parent / path.name
    require(output.name not in ("", ".", "..") and not output.exists() and not output.is_symlink(), "gate output already exists or is invalid")
    descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        offset = 0
        while offset < len(payload):
            offset += os.write(descriptor, payload[offset:])
        os.fsync(descriptor)
    except BaseException:
        os.close(descriptor)
        try:
            os.unlink(output)
        except FileNotFoundError:
            pass
        raise
    else:
        os.close(descriptor)


QueryFunction = Callable[[str, str], dict[str, Any]]
ServiceFunction = Callable[[dict[str, str]], dict[str, bool]]
NowFunction = Callable[[], dt.datetime]


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def build_compatibility_commitments(
    *,
    source_state: dict[str, Any],
    target_state: dict[str, Any],
    services: dict[str, bool],
    manifest: dict[str, Any],
    release_hashes: dict[str, str],
    runtime_hashes: dict[str, str],
    build_contract_sha256: str,
    state_evidence: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, str], dict[str, str]]:
    evidence = {
        "minimal_policy": {
            "source_project_ref": SOURCE_REF,
            "target_project_ref": TARGET_REF,
            "source_freeze_required": True,
            "active_crons_required": 0,
            "expected_job_count": len(EXPECTED_JOBS),
            "enabled_jobs_required": 0,
            "scheduler_enabled": False,
            "maximum_age_seconds": MAX_GATE_AGE_SECONDS,
        },
        "database_state": {
            "source": source_state,
            "target": target_state,
            "provenance": state_evidence,
        },
        "application_release": {
            "release_version": manifest["version"],
            "git_sha": manifest["gitSha"],
            "image": manifest["image"],
            "image_id": manifest["imageId"],
            "platform": manifest["platform"],
            "build_context_sha256": manifest["buildContextSha256"],
            "build_args_sha256": build_contract_sha256,
            "manifest_sha256": release_hashes["manifest"],
            "image_archive_sha256": release_hashes["image_archive"],
            "sha256sums_sha256": release_hashes["sha256sums"],
        },
        "runtime_config": {
            "target_project_ref": TARGET_REF,
            "target_url": TARGET_URL,
            "app_origin": APP_ORIGIN,
            "runtime_env_sha256": runtime_hashes,
            "scheduler_enabled": False,
            "viptel_listener_enabled": False,
            "build_args_sha256": build_contract_sha256,
        },
        "auth_health": {
            "target_project_ref": TARGET_REF,
            "app_origin": APP_ORIGIN,
            "auth_healthy": services["auth"],
        },
        "data_api_health": {
            "target_project_ref": TARGET_REF,
            "data_api_healthy": services["data_api"],
        },
        "storage_health": {
            "target_project_ref": TARGET_REF,
            "storage_healthy": services["storage"],
        },
        "operational_state": {
            "source_write_freeze_active": True,
            "source_deleted": False,
            "target_writable": True,
            "target_jobs_active": False,
            "scheduler_enabled": False,
        },
    }
    field_to_evidence = {
        "continuity_policy_sha256": "minimal_policy",
        "continuity_anchor_sha256": "database_state",
        "live_watermark_anchor_sha256": "application_release",
        "live_storage_anchor_sha256": "storage_health",
        "live_storage_transition_manifest_sha256": "runtime_config",
        "auth_redirect_receipt_sha256": "auth_health",
        "rentals_vercel_env_receipt_sha256": "runtime_config",
    }
    legacy_bindings = {
        field: canonical_commitment(field, evidence[evidence_name])
        for field, evidence_name in field_to_evidence.items()
    }
    component_to_evidence = {
        "application": "application_release",
        "auth": "auth_health",
        "config": "runtime_config",
        "database": "database_state",
        "storage": "storage_health",
    }
    component_bindings = {
        component: canonical_commitment(
            f"component_report_sha256.{component}", evidence[evidence_name]
        )
        for component, evidence_name in component_to_evidence.items()
    }
    compatibility_scope = {
        "schema": "target-authority/installer-compatibility-v1",
        "purpose": "field-shape compatibility with the existing installer and activation receipt",
        "commitment_algorithm": "sha256-canonical-json",
        "legacy_artifacts_reused": False,
        "legacy_semantics_claimed": False,
        "component_evidence_count": 6,
        "field_evidence": field_to_evidence,
        "component_evidence": component_to_evidence,
        "sixth_component": {
            "evidence": "operational_state",
            "sha256": canonical_commitment(
                "compatibility_component.operational_state",
                evidence["operational_state"],
            ),
        },
    }
    return (
        {"scope": compatibility_scope, "evidence": evidence},
        legacy_bindings,
        component_bindings,
    )


def create_target_authority_gate(
    release_dir: Path,
    runtime_env_dir: Path,
    build_contract_path: Path,
    migration_env_path: Path | None,
    output_path: Path,
    *,
    aggregate_evidence_path: Path | None = None,
    query_function: QueryFunction = fetch_project_state,
    service_function: ServiceFunction = probe_target_services,
    now_function: NowFunction = utc_now,
) -> None:
    started_monotonic = time.monotonic()
    started_at = now_function().replace(microsecond=0)
    manifest, release_hashes = validate_release(release_dir)
    runtime_envs, runtime_hashes = validate_runtime(runtime_env_dir, manifest)
    build_contract_sha256 = validate_build_contract(build_contract_path, manifest, runtime_envs["web"])
    require(
        (migration_env_path is None) != (aggregate_evidence_path is None),
        "exactly one aggregate-state evidence mode is required",
    )
    if aggregate_evidence_path is not None:
        source_row, target_row, state_evidence = parse_aggregate_evidence(
            aggregate_evidence_path,
            now=now_function(),
        )
        source_state, target_state = validate_project_states(source_row, target_row)
        services = service_function(runtime_envs["web"])
    else:
        require(migration_env_path is not None, "migration environment is required")
        migration_env = parse_migration_env(migration_env_path)
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as executor:
            source_future = executor.submit(query_function, SOURCE_REF, migration_env["SOURCE_SUPABASE_ACCESS_TOKEN"])
            target_future = executor.submit(query_function, TARGET_REF, migration_env["TARGET_SUPABASE_ACCESS_TOKEN"])
            services_future = executor.submit(service_function, runtime_envs["web"])
            source_state, target_state = validate_project_states(
                source_future.result(), target_future.result()
            )
            services = services_future.result()
        state_evidence = {
            "mode": "management_api",
            "source": {
                "transport": "supabase_management_api",
                "tool": "database/query",
                "read_only": True,
                "query_sha256": SOURCE_QUERY_SHA256,
            },
            "target": {
                "transport": "supabase_management_api",
                "tool": "database/query",
                "read_only": True,
                "query_sha256": TARGET_QUERY_SHA256,
            },
        }
    require(services == {"auth": True, "data_api": True, "storage": True}, "target service evidence is incomplete")
    operational_at = now_function().replace(microsecond=0)
    compatibility, legacy_bindings, component_bindings = build_compatibility_commitments(
        source_state=source_state,
        target_state=target_state,
        services=services,
        manifest=manifest,
        release_hashes=release_hashes,
        runtime_hashes=runtime_hashes,
        build_contract_sha256=build_contract_sha256,
        state_evidence=state_evidence,
    )
    completed_at = now_function().replace(microsecond=0)
    revalidate_aggregate_evidence_freshness(
        state_evidence,
        now=completed_at,
    )
    duration = int((completed_at - started_at).total_seconds())
    require(time.monotonic() - started_monotonic <= MAX_VALIDATION_SECONDS and 0 <= duration <= MAX_VALIDATION_SECONDS, "target authority validation exceeded 120 seconds")
    snapshot_id = operational_at.strftime("%Y%m%dT%H%M%SZ")
    gate_run_id = f"{snapshot_id}-{os.getpid()}-{time.monotonic_ns()}"
    gate = {
        "schema": "target-authority/v1",
        "gate_status": "pass_predeployment",
        "failures": [],
        "snapshot_id": snapshot_id,
        "gate_run_id": gate_run_id,
        "source_project_ref": SOURCE_REF,
        "target_project_ref": TARGET_REF,
        "source_write_freeze_active": True,
        "source_deleted": False,
        "target_writable": True,
        "target_jobs_active": False,
        "scheduler_enabled": False,
        "source": source_state,
        "target": target_state,
        "state_evidence": state_evidence,
        "target_services": services,
        "image_target_only": True,
        "runtime_target_only": True,
        "release_version": manifest["version"],
        "git_sha": manifest["gitSha"],
        "image": manifest["image"],
        "image_id": manifest["imageId"],
        "platform": manifest["platform"],
        "build_context_sha256": manifest["buildContextSha256"],
        "build_args_sha256": build_contract_sha256,
        "manifest_sha256": release_hashes["manifest"],
        "image_archive_sha256": release_hashes["image_archive"],
        "sha256sums_sha256": release_hashes["sha256sums"],
        "runtime_env_sha256": runtime_hashes,
        **legacy_bindings,
        "component_report_sha256": component_bindings,
        "compatibility": compatibility,
        "component_evidence_count": 6,
        "production_cutover_performed": False,
        "validated_at_utc": format_utc(operational_at),
        "gate_started_at_utc": format_utc(started_at),
        "completed_at_utc": format_utc(completed_at),
        "operational_state_validated_at_utc": format_utc(operational_at),
        "gate_run_duration_seconds": duration,
        "maximum_component_age_seconds": int(
            (completed_at - operational_at).total_seconds()
        ),
        "validation_started_at_utc": format_utc(started_at),
        "validation_duration_seconds": duration,
        "maximum_age_seconds": MAX_GATE_AGE_SECONDS,
        "valid_until_utc": format_utc(completed_at + dt.timedelta(seconds=MAX_GATE_AGE_SECONDS)),
    }
    payload = (json.dumps(gate, separators=(",", ":"), ensure_ascii=True) + "\n").encode("utf-8")
    revalidate_aggregate_evidence_freshness(
        state_evidence,
        now=now_function(),
    )
    write_private_exclusive(output_path, payload)


def main() -> None:
    parser = argparse.ArgumentParser(description="Create the minimal Frankfurt target-authority cutover gate.")
    parser.add_argument("release_dir")
    parser.add_argument("runtime_env_dir")
    parser.add_argument("build_contract")
    parser.add_argument(
        "migration_env",
        help="private migration env for PAT mode, or '-' with --aggregate-evidence",
    )
    parser.add_argument("output_gate")
    parser.add_argument("--aggregate-evidence")
    args = parser.parse_args()
    os.umask(0o077)
    try:
        require(
            (args.aggregate_evidence is None and args.migration_env != "-")
            or (args.aggregate_evidence is not None and args.migration_env == "-"),
            "use either a migration env or '-' with --aggregate-evidence",
        )
        create_target_authority_gate(
            Path(args.release_dir),
            Path(args.runtime_env_dir),
            Path(args.build_contract),
            None if args.migration_env == "-" else Path(args.migration_env),
            Path(args.output_gate),
            aggregate_evidence_path=(
                Path(args.aggregate_evidence)
                if args.aggregate_evidence is not None
                else None
            ),
        )
    except GateError as error:
        raise SystemExit(f"Target authority gate failed: {error}") from None


if __name__ == "__main__":
    main()
