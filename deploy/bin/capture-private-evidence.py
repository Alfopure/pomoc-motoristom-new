#!/usr/bin/env python3

import os
import stat
import sys


def main() -> None:
    if len(sys.argv) not in (3, 4):
        raise SystemExit("usage: capture-private-evidence.py SOURCE DESTINATION [--allow-public-source]")

    source_path, destination_path = sys.argv[1:3]
    allow_public_source = len(sys.argv) == 4 and sys.argv[3] == "--allow-public-source"
    if len(sys.argv) == 4 and not allow_public_source:
        raise SystemExit("invalid capture mode")
    nofollow = getattr(os, "O_NOFOLLOW", 0)
    destination_created = False
    source_descriptor = os.open(source_path, os.O_RDONLY | nofollow)
    try:
        source_before = os.fstat(source_descriptor)
        if not stat.S_ISREG(source_before.st_mode) or source_before.st_nlink != 1:
            raise SystemExit("source evidence must be a regular file with one link")
        if source_before.st_uid not in {0, os.geteuid()}:
            raise SystemExit("source evidence must be owned by root or the current user")
        source_permissions = stat.S_IMODE(source_before.st_mode)
        if allow_public_source:
            if source_permissions & 0o022:
                raise SystemExit("public source must not be group/world writable")
        elif source_permissions & 0o077:
            raise SystemExit("source evidence must be private")

        destination_descriptor = os.open(
            destination_path,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | nofollow,
            0o600,
        )
        destination_created = True
        try:
            copied = 0
            while True:
                chunk = os.read(source_descriptor, 1024 * 1024)
                if not chunk:
                    break
                view = memoryview(chunk)
                while view:
                    written = os.write(destination_descriptor, view)
                    view = view[written:]
                    copied += written
            os.fsync(destination_descriptor)
        finally:
            os.close(destination_descriptor)

        source_after = os.fstat(source_descriptor)
        stable_fields = (
            source_before.st_dev == source_after.st_dev,
            source_before.st_ino == source_after.st_ino,
            source_before.st_size == source_after.st_size == copied,
            source_before.st_mtime_ns == source_after.st_mtime_ns,
            source_after.st_nlink == 1,
        )
        if not all(stable_fields):
            os.unlink(destination_path)
            raise SystemExit("source evidence changed while it was captured")
    except BaseException:
        if destination_created:
            try:
                os.unlink(destination_path)
            except FileNotFoundError:
                pass
        raise
    finally:
        os.close(source_descriptor)


if __name__ == "__main__":
    main()
