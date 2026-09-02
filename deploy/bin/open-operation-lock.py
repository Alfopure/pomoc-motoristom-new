#!/usr/bin/env python3
"""Safely open the common operations lock and pass it across exec."""

from __future__ import annotations

import errno
import fcntl
import os
import stat
import sys
from typing import NoReturn


LOCK_NAME = ".motorist-operation.lock"
LOCK_MARKER = b"motorist-operation-lock/v1\n"
LOCK_FD = 9


def fail(message: str) -> NoReturn:
    raise SystemExit(message)


def validate_root(argument: str) -> str:
    root = os.path.abspath(argument)
    try:
        metadata = os.lstat(root)
    except OSError:
        fail("Operation-lock directory is unavailable")
    if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        fail("Operation-lock directory is unsafe")
    if os.path.realpath(root) != root:
        fail("Operation-lock directory must not traverse symlinks")
    if metadata.st_uid != os.geteuid():
        fail("Operation-lock directory has an unexpected owner")
    mode = stat.S_IMODE(metadata.st_mode)
    if mode & 0o077:
        fail("Operation-lock directory permissions are unsafe")
    return root


def prepare_root(argument: str) -> str:
    root = os.path.abspath(argument)
    parent = os.path.dirname(root)
    name = os.path.basename(root)
    if not name or name in (".", ".."):
        fail("Operation-lock directory path is unsafe")
    try:
        parent_metadata = os.lstat(parent)
    except OSError:
        fail("Operation-lock parent directory is unavailable")
    if not stat.S_ISDIR(parent_metadata.st_mode) or stat.S_ISLNK(parent_metadata.st_mode):
        fail("Operation-lock parent directory is unsafe")
    if os.path.realpath(parent) != parent:
        fail("Operation-lock parent directory must not traverse symlinks")
    if parent_metadata.st_uid != os.geteuid():
        fail("Operation-lock parent directory has an unexpected owner")
    if stat.S_IMODE(parent_metadata.st_mode) & 0o027:
        fail("Operation-lock parent directory permissions are unsafe")

    no_follow = getattr(os, "O_NOFOLLOW", 0)
    if not no_follow:
        fail("O_NOFOLLOW support is required")
    try:
        parent_descriptor = os.open(
            parent,
            os.O_RDONLY | os.O_DIRECTORY | no_follow,
        )
    except OSError:
        fail("Operation-lock parent directory cannot be opened safely")
    try:
        opened_parent = os.fstat(parent_descriptor)
        if (opened_parent.st_dev, opened_parent.st_ino) != (
            parent_metadata.st_dev,
            parent_metadata.st_ino,
        ):
            fail("Operation-lock parent directory changed during validation")
        try:
            os.mkdir(name, mode=0o700, dir_fd=parent_descriptor)
            created = True
        except FileExistsError:
            created = False
        try:
            root_descriptor = os.open(
                name,
                os.O_RDONLY | os.O_DIRECTORY | no_follow,
                dir_fd=parent_descriptor,
            )
        except OSError:
            fail("Operation-lock directory cannot be opened safely")
        try:
            metadata = os.fstat(root_descriptor)
            path_metadata = os.lstat(root)
            if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(path_metadata.st_mode):
                fail("Operation-lock directory is unsafe")
            if metadata.st_uid != os.geteuid() or path_metadata.st_uid != os.geteuid():
                fail("Operation-lock directory has an unexpected owner")
            if (metadata.st_dev, metadata.st_ino) != (
                path_metadata.st_dev,
                path_metadata.st_ino,
            ):
                fail("Operation-lock directory changed during validation")
            mode = stat.S_IMODE(metadata.st_mode)
            if not created and mode & 0o027:
                fail("Operation-lock directory permissions are unsafe")
            os.fchmod(root_descriptor, 0o700)
            os.fsync(root_descriptor)
        finally:
            os.close(root_descriptor)
        if created:
            os.fsync(parent_descriptor)
    finally:
        os.close(parent_descriptor)
    return validate_root(root)


def validate_descriptor(descriptor: int, root: str) -> None:
    path = os.path.join(root, LOCK_NAME)
    try:
        descriptor_metadata = os.fstat(descriptor)
        path_metadata = os.lstat(path)
    except OSError:
        fail("Operation lock is unavailable")
    if not stat.S_ISREG(descriptor_metadata.st_mode):
        fail("Operation lock is not a regular file")
    if stat.S_ISLNK(path_metadata.st_mode) or not stat.S_ISREG(path_metadata.st_mode):
        fail("Operation lock path is unsafe")
    if descriptor_metadata.st_nlink != 1 or path_metadata.st_nlink != 1:
        fail("Operation lock must have exactly one link")
    if descriptor_metadata.st_uid != os.geteuid() or path_metadata.st_uid != os.geteuid():
        fail("Operation lock has an unexpected owner")
    if stat.S_IMODE(descriptor_metadata.st_mode) != 0o600 or stat.S_IMODE(path_metadata.st_mode) != 0o600:
        fail("Operation lock permissions are unsafe")
    if (descriptor_metadata.st_dev, descriptor_metadata.st_ino) != (
        path_metadata.st_dev,
        path_metadata.st_ino,
    ):
        fail("Operation lock descriptor does not match its path")
    try:
        contents = os.pread(descriptor, len(LOCK_MARKER) + 1, 0)
    except OSError:
        fail("Operation lock cannot be read")
    if descriptor_metadata.st_size != len(LOCK_MARKER) or contents != LOCK_MARKER:
        fail("Operation lock was truncated or modified")


def open_lock(root: str) -> int:
    path = os.path.join(root, LOCK_NAME)
    no_follow = getattr(os, "O_NOFOLLOW", 0)
    if not no_follow:
        fail("O_NOFOLLOW support is required")
    flags = os.O_RDWR | no_follow
    created = False
    try:
        descriptor = os.open(path, flags | os.O_CREAT | os.O_EXCL, 0o600)
        created = True
    except FileExistsError:
        try:
            descriptor = os.open(path, flags)
        except OSError:
            fail("Existing operation lock is unsafe")
    except OSError:
        fail("Operation lock cannot be created safely")

    try:
        if created:
            os.fchmod(descriptor, 0o600)
            written = 0
            while written < len(LOCK_MARKER):
                written += os.write(descriptor, LOCK_MARKER[written:])
            os.fsync(descriptor)
        validate_descriptor(descriptor, root)
    except BaseException:
        os.close(descriptor)
        raise
    return descriptor


def acquire_lock(descriptor: int) -> None:
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as error:
        if error.errno in (errno.EACCES, errno.EAGAIN):
            fail("Another motorist operation is active")
        fail("Operation lock could not be acquired")


def exec_with_lock(root_argument: str, command: list[str]) -> None:
    root = validate_root(root_argument)
    if not command:
        fail("Operation-lock command is missing")
    descriptor = open_lock(root)
    acquire_lock(descriptor)
    if descriptor != LOCK_FD:
        os.dup2(descriptor, LOCK_FD, inheritable=True)
        os.close(descriptor)
    else:
        os.set_inheritable(descriptor, True)
    environment = os.environ.copy()
    environment["MOTORIST_OPERATION_LOCK_FD"] = str(LOCK_FD)
    environment["MOTORIST_OPERATION_LOCK_ROOT"] = root
    try:
        os.execvpe(command[0], command, environment)
    except OSError:
        fail("Operation-lock command could not be executed")


def verify_and_lock(root_argument: str, descriptor_argument: str) -> None:
    root = validate_root(root_argument)
    if os.environ.get("MOTORIST_OPERATION_LOCK_ROOT") != root:
        fail("Operation-lock root binding is invalid")
    try:
        descriptor = int(descriptor_argument, 10)
    except ValueError:
        fail("Operation-lock descriptor is invalid")
    if descriptor != LOCK_FD or os.environ.get("MOTORIST_OPERATION_LOCK_FD") != str(LOCK_FD):
        fail("Operation-lock descriptor binding is invalid")
    validate_descriptor(descriptor, root)
    acquire_lock(descriptor)


def main() -> None:
    if len(sys.argv) == 3 and sys.argv[1] == "prepare":
        prepare_root(sys.argv[2])
        return
    if len(sys.argv) >= 5 and sys.argv[1] == "exec" and sys.argv[3] == "--":
        exec_with_lock(sys.argv[2], sys.argv[4:])
        return
    if len(sys.argv) == 4 and sys.argv[1] == "verify":
        verify_and_lock(sys.argv[2], sys.argv[3])
        return
    fail(
        "usage: open-operation-lock.py prepare DIRECTORY | "
        "exec DIRECTORY -- COMMAND [ARG ...] | verify DIRECTORY FD"
    )


if __name__ == "__main__":
    main()
