#!/usr/bin/env python3

import datetime
import re
import sys


def main() -> None:
    if len(sys.argv) not in (2, 3):
        raise SystemExit("usage: validate-gate-timestamp.py VALIDATED_AT_UTC [MAXIMUM_AGE_SECONDS]")

    value = sys.argv[1]
    maximum_age_seconds = 30 * 60
    if len(sys.argv) == 3:
        try:
            maximum_age_seconds = int(sys.argv[2])
        except ValueError as error:
            raise SystemExit("maximum gate age must be an integer") from error
        if maximum_age_seconds < 1 or maximum_age_seconds > 30 * 60:
            raise SystemExit("maximum gate age must be between 1 and 1800 seconds")
    if not re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z", value):
        raise SystemExit("cutover gate validated_at_utc is not a strict UTC timestamp")
    try:
        validated_at = datetime.datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(
            tzinfo=datetime.timezone.utc
        )
    except ValueError as error:
        raise SystemExit("cutover gate validated_at_utc is invalid") from error

    age_seconds = (datetime.datetime.now(datetime.timezone.utc) - validated_at).total_seconds()
    if age_seconds < 0:
        raise SystemExit("cutover gate timestamp is in the future")
    if age_seconds > maximum_age_seconds:
        raise SystemExit("cutover gate is older than the allowed action window")


if __name__ == "__main__":
    main()
