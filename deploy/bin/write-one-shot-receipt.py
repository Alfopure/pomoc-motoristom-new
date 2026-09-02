#!/usr/bin/env python3

import datetime
import json
import os
import re
import stat
import sys


TARGET_REF = "sjcsrygkkmersoczpunh"
SOURCE_REF = "jcwbiulwuwyrnmzjjbgr"
SAFE_JOBS = {
    "fleet.webdispecink.positions",
    "fleet.webdispecink.catalog",
    "fleet.commander.positions",
    "fleet.commander.catalog",
    "notifications.materialize",
    "telephony.recordings.sync",
    "telephony.transcripts.process",
    "telephony.viptel.reconcile",
    "infra.hetzner.audit",
}


def require(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(message)


def main() -> None:
    if len(sys.argv) != 7:
        raise SystemExit(
            "usage: write-one-shot-receipt.py RECEIPT RESULT RELEASE_VERSION IMAGE_ID JOB RUNTIME_ENV_SHA256"
        )

    receipt_path, result_path, release_version, image_id, job, runtime_env_sha256 = sys.argv[1:]
    require(job in SAFE_JOBS, "one-shot job is not allowed")
    require(
        re.fullmatch(r"hetzner-[A-Za-z0-9][A-Za-z0-9._-]{0,95}", release_version)
        is not None,
        "invalid release version",
    )
    require(
        re.fullmatch(r"sha256:[0-9a-f]{64}", image_id) is not None,
        "invalid image ID",
    )
    require(
        re.fullmatch(r"[0-9a-f]{64}", runtime_env_sha256) is not None,
        "invalid runtime env fingerprint",
    )

    result_metadata = os.stat(result_path, follow_symlinks=False)
    require(stat.S_ISREG(result_metadata.st_mode), "one-shot result is not a regular file")
    require(stat.S_IMODE(result_metadata.st_mode) & 0o077 == 0, "one-shot result is not private")
    require(result_metadata.st_nlink == 1, "one-shot result has multiple links")
    require(result_metadata.st_size <= 16384, "one-shot result is too large")
    with open(result_path, "r", encoding="utf-8") as result_file:
        contents = result_file.read()
    require(contents.endswith("\n") and contents.count("\n") == 1, "one-shot output must be one line")
    try:
        result = json.loads(contents)
    except json.JSONDecodeError as error:
        raise SystemExit("one-shot output is not JSON") from error

    require(isinstance(result, dict), "one-shot output is not an object")
    require(result.get("schema") == "motorist-one-shot/v1", "one-shot schema mismatch")
    require(result.get("job") == job, "one-shot job mismatch")
    require(type(result.get("ok")) is bool, "one-shot result has no boolean outcome")
    status = result.get("status")
    require(status in ("success", "skipped", "failed"), "one-shot status is invalid")
    if result["ok"]:
        require(status == "success", "successful one-shot must have success status")
    summary = result.get("summary", {})
    require(isinstance(summary, dict), "one-shot summary is not an object")

    serialized_summary = json.dumps(summary, sort_keys=True, separators=(",", ":"))
    lowered = serialized_summary.lower()
    require(SOURCE_REF not in serialized_summary, "source ref is present in one-shot result")
    require(TARGET_REF not in serialized_summary, "project ref is present in one-shot summary")
    require("http://" not in lowered and "https://" not in lowered, "URL is present in one-shot summary")
    require("@" not in serialized_summary, "email-like value is present in one-shot summary")
    require(
        re.search(r"\+?\d[\d\s()\-]{7,}\d", serialized_summary) is None,
        "phone-like value is present in one-shot summary",
    )

    receipt = {
        "schema": "motorist-one-shot/v1",
        "recordedAtUtc": datetime.datetime.now(datetime.timezone.utc).strftime(
            "%Y-%m-%dT%H:%M:%SZ"
        ),
        "releaseVersion": release_version,
        "imageId": image_id,
        "runtimeEnvSha256": runtime_env_sha256,
        "targetProjectRef": TARGET_REF,
        "job": job,
        "ok": result["ok"],
        "status": status,
        "summary": summary,
    }
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(receipt_path, flags, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as receipt_file:
        metadata = os.fstat(receipt_file.fileno())
        require(stat.S_ISREG(metadata.st_mode), "receipt is not a regular file")
        require(metadata.st_nlink == 1, "receipt has multiple links")
        require(stat.S_IMODE(metadata.st_mode) == 0o600, "receipt is not mode 0600")
        receipt_file.write(json.dumps(receipt, sort_keys=True, separators=(",", ":")) + "\n")
        receipt_file.flush()
        os.fsync(receipt_file.fileno())


if __name__ == "__main__":
    main()
