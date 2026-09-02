#!/usr/bin/env python3

import hashlib
import json
import os
import stat
import struct
import sys


MAX_FILE_BYTES = 256 * 1024 * 1024
DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC


def fail(message):
    raise RuntimeError(message)


def same_inode(left, right):
    return left.st_dev == right.st_dev and left.st_ino == right.st_ino


def checked_relative_path(trusted_root, candidate):
    lexical_root = os.path.abspath(trusted_root)
    lexical_candidate = os.path.abspath(candidate)
    relative_path = os.path.relpath(lexical_candidate, lexical_root)
    if relative_path == "." or relative_path == ".." or relative_path.startswith(f"..{os.sep}"):
        fail("candidate is outside the trusted root")
    components = relative_path.split(os.sep)
    if any(component in ("", ".", "..") for component in components):
        fail("candidate contains an invalid path component")
    return lexical_root, components


def open_directory(parent_fd, component):
    before = os.stat(component, dir_fd=parent_fd, follow_symlinks=False)
    if stat.S_ISLNK(before.st_mode):
        fail("path component is a symbolic link")
    if not stat.S_ISDIR(before.st_mode):
        fail("path component is not a directory")
    descriptor = os.open(component, DIRECTORY_FLAGS, dir_fd=parent_fd)
    opened = os.fstat(descriptor)
    if not stat.S_ISDIR(opened.st_mode) or not same_inode(before, opened):
        os.close(descriptor)
        fail("path component changed while it was opened")
    return descriptor, opened


def open_trusted_chain(trusted_root, candidate):
    lexical_root, candidate_components = checked_relative_path(trusted_root, candidate)
    canonical_root = os.path.realpath(lexical_root)
    if not os.path.isabs(canonical_root):
        fail("trusted root is not absolute")
    expected_root = os.stat(canonical_root, follow_symlinks=False)
    if not stat.S_ISDIR(expected_root.st_mode):
        fail("trusted root is not a directory")

    descriptors = [os.open(os.sep, DIRECTORY_FLAGS)]
    entries = []
    try:
        for component in [part for part in canonical_root.split(os.sep) if part]:
            descriptor, opened = open_directory(descriptors[-1], component)
            entries.append((descriptors[-1], component, descriptor, opened))
            descriptors.append(descriptor)
        if not same_inode(os.fstat(descriptors[-1]), expected_root):
            fail("trusted root changed while it was opened")
        if not same_inode(os.stat(lexical_root), expected_root):
            fail("trusted root alias changed while it was opened")

        for component in candidate_components[:-1]:
            descriptor, opened = open_directory(descriptors[-1], component)
            entries.append((descriptors[-1], component, descriptor, opened))
            descriptors.append(descriptor)
        return descriptors, entries, candidate_components[-1]
    except Exception:
        for descriptor in reversed(descriptors):
            os.close(descriptor)
        raise


def verify_chain(entries):
    for parent_fd, component, descriptor, opened in entries:
        current = os.stat(component, dir_fd=parent_fd, follow_symlinks=False)
        if not stat.S_ISDIR(current.st_mode):
            fail("path component is no longer a directory")
        if not same_inode(current, opened) or not same_inode(os.fstat(descriptor), opened):
            fail("path component changed during the file operation")


def close_chain(descriptors):
    for descriptor in reversed(descriptors):
        os.close(descriptor)


def stable_file_signature(metadata):
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_mode,
        metadata.st_nlink,
        metadata.st_uid,
        metadata.st_size,
        metadata.st_mtime_ns,
        metadata.st_ctime_ns,
    )


def verify_final_entry(parent_fd, name, opened):
    current = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    if not stat.S_ISREG(current.st_mode):
        fail("final path is no longer a regular file")
    if not same_inode(current, opened):
        fail("final path changed during the file operation")


def read_file(trusted_root, candidate, private_file, owner_uid):
    descriptors, entries, file_name = open_trusted_chain(trusted_root, candidate)
    descriptor = None
    try:
        before = os.stat(file_name, dir_fd=descriptors[-1], follow_symlinks=False)
        if stat.S_ISLNK(before.st_mode):
            fail("final path is a symbolic link")
        if not stat.S_ISREG(before.st_mode):
            fail("final path is not a regular file")
        descriptor = os.open(
            file_name,
            os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC,
            dir_fd=descriptors[-1],
        )
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode) or not same_inode(before, opened):
            fail("final path changed while it was opened")
        if opened.st_nlink != 1:
            fail("final path has multiple hard links")
        if private_file and opened.st_mode & 0o077:
            fail("final path is not private")
        if owner_uid >= 0 and opened.st_uid != owner_uid:
            fail("final path has an unexpected owner")
        if opened.st_size > MAX_FILE_BYTES:
            fail("final path exceeds the secure snapshot size limit")

        chunks = []
        remaining = MAX_FILE_BYTES + 1
        while remaining > 0:
            chunk = os.read(descriptor, min(1024 * 1024, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        contents = b"".join(chunks)
        if len(contents) > MAX_FILE_BYTES:
            fail("final path exceeds the secure snapshot size limit")
        after = os.fstat(descriptor)
        if stable_file_signature(after) != stable_file_signature(opened):
            fail("final path contents changed during the read")
        verify_final_entry(descriptors[-1], file_name, opened)
        verify_chain(entries)
        metadata = json.dumps(
            {
                "mode": opened.st_mode,
                "sha256": hashlib.sha256(contents).hexdigest(),
            },
            separators=(",", ":"),
        ).encode("utf-8")
        sys.stdout.buffer.write(struct.pack(">I", len(metadata)))
        sys.stdout.buffer.write(metadata)
        sys.stdout.buffer.write(contents)
    finally:
        if descriptor is not None:
            os.close(descriptor)
        close_chain(descriptors)


def write_file(trusted_root, candidate, mode):
    contents = sys.stdin.buffer.read(MAX_FILE_BYTES + 1)
    if len(contents) > MAX_FILE_BYTES:
        fail("output exceeds the secure snapshot size limit")
    descriptors, entries, file_name = open_trusted_chain(trusted_root, candidate)
    descriptor = None
    try:
        descriptor = os.open(
            file_name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
            mode,
            dir_fd=descriptors[-1],
        )
        os.fchmod(descriptor, mode)
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode):
            fail("output did not open as a regular file")
        if opened.st_nlink != 1:
            fail("output has multiple hard links")
        if opened.st_mode & 0o077:
            fail("output is not private")
        offset = 0
        while offset < len(contents):
            offset += os.write(descriptor, contents[offset:])
        os.fsync(descriptor)
        after = os.fstat(descriptor)
        if after.st_size != len(contents) or not same_inode(after, opened):
            fail("output changed during the write")
        verify_final_entry(descriptors[-1], file_name, opened)
        verify_chain(entries)
        os.fsync(descriptors[-1])
        sys.stdout.write(json.dumps({"sha256": hashlib.sha256(contents).hexdigest()}))
    finally:
        if descriptor is not None:
            os.close(descriptor)
        close_chain(descriptors)


def main(arguments):
    if len(arguments) < 1:
        fail("operation is missing")
    if arguments[0] == "read" and len(arguments) == 5:
        read_file(arguments[1], arguments[2], arguments[3] == "1", int(arguments[4]))
        return
    if arguments[0] == "write" and len(arguments) == 4:
        write_file(arguments[1], arguments[2], int(arguments[3]))
        return
    fail("operation arguments are invalid")


try:
    main(sys.argv[1:])
except Exception as error:
    sys.stderr.write(f"SECURE_OPENAT_FAILED: {error}\n")
    sys.exit(1)
