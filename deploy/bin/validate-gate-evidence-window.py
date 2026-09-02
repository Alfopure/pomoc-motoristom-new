#!/usr/bin/env python3

import datetime
import json
import math
import re
import sys


MAXIMUM_SECONDS = 30 * 60
TIMESTAMP_PATTERN = re.compile(
    r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z$"
)


def parse_timestamp(value: str) -> datetime.datetime:
    if not TIMESTAMP_PATTERN.fullmatch(value):
        raise SystemExit("gate evidence timestamp is not strict UTC")
    try:
        return datetime.datetime.fromisoformat(value.removesuffix("Z") + "+00:00")
    except ValueError as error:
        raise SystemExit("gate evidence timestamp is invalid") from error


def strict_seconds(value: datetime.datetime) -> datetime.datetime:
    return value.replace(microsecond=0)


def main() -> None:
    if len(sys.argv) < 3:
        raise SystemExit(
            "usage: validate-gate-evidence-window.py GATE_STARTED_AT_UTC COMPONENT_TIMESTAMP..."
        )

    started = parse_timestamp(sys.argv[1])
    components = [parse_timestamp(value) for value in sys.argv[2:]]
    completed = datetime.datetime.now(datetime.timezone.utc)
    if completed < started:
        raise SystemExit("gate completion precedes its start")
    if any(component < started or component > completed for component in components):
        raise SystemExit("gate component timestamp is outside the current run")

    oldest = min(components)
    started_seconds = strict_seconds(started)
    oldest_seconds = strict_seconds(oldest)
    completed_seconds = strict_seconds(completed)
    run_duration = math.ceil((completed_seconds - started_seconds).total_seconds())
    maximum_component_age = math.ceil((completed_seconds - oldest_seconds).total_seconds())
    if run_duration > MAXIMUM_SECONDS:
        raise SystemExit("gate run exceeded 30 minutes")
    if maximum_component_age > MAXIMUM_SECONDS:
        raise SystemExit("gate component evidence exceeded 30 minutes")

    print(
        json.dumps(
            {
                "gate_started_at_utc": started_seconds.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "completed_at_utc": completed_seconds.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "validated_at_utc": oldest_seconds.strftime("%Y-%m-%dT%H:%M:%SZ"),
                "gate_run_duration_seconds": run_duration,
                "maximum_component_age_seconds": maximum_component_age,
                "component_count": len(components),
            },
            sort_keys=True,
            separators=(",", ":"),
        )
    )


if __name__ == "__main__":
    main()
