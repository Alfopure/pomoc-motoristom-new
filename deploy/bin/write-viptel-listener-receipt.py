#!/usr/bin/env python3

"""Write one immutable, aggregate-only VIPTel candidate-probe receipt."""

from __future__ import annotations

import datetime as dt
import json
import os
import re
import stat
import sys
from pathlib import Path


TARGET_REF = "sjcsrygkkmersoczpunh"
RELEASE_PATTERN = re.compile(r"hetzner-[A-Za-z0-9][A-Za-z0-9._-]{0,95}")
IMAGE_ID_PATTERN = re.compile(r"sha256:[0-9a-f]{64}")
SHA256_PATTERN = re.compile(r"[0-9a-f]{64}")
UTC_PATTERN = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z")


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


def parse_boolean(value: str, field: str) -> bool:
    require(value in ("true", "false"), f"{field} must be true or false")
    return value == "true"


def parse_count(value: str, field: str) -> int:
    require(re.fullmatch(r"\d{1,9}", value) is not None, f"{field} is invalid")
    return int(value)


def parse_utc(value: str, field: str, *, optional: bool = False) -> str | None:
    if optional and value == "-":
        return None
    require(UTC_PATTERN.fullmatch(value) is not None, f"{field} is not a UTC timestamp")
    try:
        parsed = dt.datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(
            tzinfo=dt.timezone.utc
        )
    except ValueError as error:
        raise SystemExit(f"{field} is invalid") from error
    require(
        parsed <= dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=5),
        f"{field} is in the future",
    )
    return value


def validate_destination(path: Path) -> Path:
    absolute = Path(os.path.abspath(path))
    require(Path(os.path.realpath(absolute.parent)) == absolute.parent, "receipt directory traverses a symlink")
    parent = os.lstat(absolute.parent)
    require(stat.S_ISDIR(parent.st_mode), "receipt parent is not a directory")
    require(not stat.S_ISLNK(parent.st_mode), "receipt parent must not be a symlink")
    require(stat.S_IMODE(parent.st_mode) & 0o077 == 0, "receipt directory must be private")
    require(parent.st_uid in {0, os.geteuid()}, "receipt directory has an unsafe owner")
    require(not os.path.lexists(absolute), "receipt already exists")
    return absolute


def main() -> None:
    if len(sys.argv) != 13:
        raise SystemExit(
            "usage: write-viptel-listener-receipt.py RECEIPT RELEASE_VERSION IMAGE_ID "
            "RUNTIME_ENV_SHA256 STATUS CONNECTED RECONNECTED INBOUND_COUNT OUTBOUND_COUNT "
            "PROBE_STARTED_AT CALL_WINDOW_STARTED_AT CALL_WINDOW_ENDED_AT"
        )

    (
        receipt_argument,
        release_version,
        image_id,
        runtime_env_sha256,
        status_value,
        connected_value,
        reconnected_value,
        inbound_value,
        outbound_value,
        probe_started_value,
        call_window_started_value,
        call_window_ended_value,
    ) = sys.argv[1:]

    receipt_path = validate_destination(Path(receipt_argument))
    require(RELEASE_PATTERN.fullmatch(release_version) is not None, "release version is invalid")
    require(IMAGE_ID_PATTERN.fullmatch(image_id) is not None, "image ID is invalid")
    require(SHA256_PATTERN.fullmatch(runtime_env_sha256) is not None, "runtime env fingerprint is invalid")
    require(status_value in ("success", "failed"), "receipt status is invalid")
    connected = parse_boolean(connected_value, "connected")
    reconnected = parse_boolean(reconnected_value, "reconnected")
    inbound_count = parse_count(inbound_value, "inbound count")
    outbound_count = parse_count(outbound_value, "outbound count")
    probe_started_at = parse_utc(probe_started_value, "probe start")
    call_window_started_at = parse_utc(
        call_window_started_value,
        "call window start",
        optional=True,
    )
    call_window_ended_at = parse_utc(
        call_window_ended_value,
        "call window end",
        optional=True,
    )
    completed = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
    completed_at = completed.strftime("%Y-%m-%dT%H:%M:%SZ")

    require(
        (call_window_started_at is None) == (call_window_ended_at is None),
        "receipt call window is incomplete",
    )
    if call_window_started_at is not None and call_window_ended_at is not None:
        call_window_start = dt.datetime.strptime(
            call_window_started_at, "%Y-%m-%dT%H:%M:%SZ"
        ).replace(tzinfo=dt.timezone.utc)
        call_window_end = dt.datetime.strptime(
            call_window_ended_at, "%Y-%m-%dT%H:%M:%SZ"
        ).replace(tzinfo=dt.timezone.utc)
        require(call_window_start < call_window_end, "receipt call window is invalid")

    success = status_value == "success"
    if success:
        require(connected, "successful receipt requires an initial connection")
        require(reconnected, "successful receipt requires a reconnection")
        require(inbound_count > 0, "successful receipt requires a real inbound call")
        require(outbound_count > 0, "successful receipt requires a real outbound call")
        require(call_window_started_at is not None, "successful receipt requires a call window")
        require(call_window_ended_at is not None, "successful receipt requires a call window end")

    receipt = {
        "schema": "motorist-viptel-listener/v2",
        "recordedAtUtc": completed_at,
        "probeStartedAtUtc": probe_started_at,
        "callWindowStartedAtUtc": call_window_started_at,
        "callWindowEndedAtUtc": call_window_ended_at,
        "releaseVersion": release_version,
        "imageId": image_id,
        "runtimeEnvSha256": runtime_env_sha256,
        "targetProjectRef": TARGET_REF,
        "ok": success,
        "status": status_value,
        "listenerConnected": connected,
        "listenerReconnected": reconnected,
        "incomingCallTested": inbound_count > 0,
        "outgoingCallTested": outbound_count > 0,
        "summary": {
            "websocketConnectionsObserved": 2 if reconnected else (1 if connected else 0),
            "inboundCallsObserved": inbound_count,
            "outboundCallsObserved": outbound_count,
        },
    }

    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(receipt_path, flags, 0o600)
    try:
        metadata = os.fstat(descriptor)
        require(stat.S_ISREG(metadata.st_mode), "receipt is not a regular file")
        require(metadata.st_nlink == 1, "receipt has multiple links")
        require(stat.S_IMODE(metadata.st_mode) == 0o600, "receipt is not mode 0600")
        payload = json.dumps(receipt, sort_keys=True, separators=(",", ":")) + "\n"
        os.write(descriptor, payload.encode("utf-8"))
        os.fsync(descriptor)
    except BaseException:
        os.close(descriptor)
        try:
            os.unlink(receipt_path)
        except FileNotFoundError:
            pass
        raise
    else:
        os.close(descriptor)


if __name__ == "__main__":
    main()
