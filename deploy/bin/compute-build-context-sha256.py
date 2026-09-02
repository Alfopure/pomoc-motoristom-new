#!/usr/bin/env python3

import hashlib
import os
import stat
import sys
from pathlib import Path


EXPECTED_DOCKERIGNORE = (
    ".git\n"
    ".github\n"
    ".next\n"
    ".context\n"
    ".omx\n"
    ".vercel\n"
    "node_modules\n"
    "dist\n"
    "coverage\n"
    "deploy/env\n"
    "deploy/releases\n"
    "supabase/.temp\n"
    ".env\n"
    ".env.*\n"
    "*.log\n"
    "*.tsbuildinfo\n"
)

IGNORED_DIRECTORIES = {
    ".git",
    ".github",
    ".next",
    ".context",
    ".omx",
    ".vercel",
    "node_modules",
    "dist",
    "coverage",
    "deploy/env",
    "deploy/releases",
    "supabase/.temp",
}


def fail(message: str) -> None:
    raise SystemExit(message)


def ignored_file(name: str) -> bool:
    return (
        name == ".env"
        or name.startswith(".env.")
        or name.endswith(".log")
        or name.endswith(".tsbuildinfo")
    )


def digest_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    if len(sys.argv) != 2:
        fail("usage: compute-build-context-sha256.py REPOSITORY_ROOT")

    root = Path(sys.argv[1]).resolve(strict=True)
    dockerignore = root / ".dockerignore"
    if not dockerignore.is_file() or dockerignore.read_text(encoding="utf-8") != EXPECTED_DOCKERIGNORE:
        fail(".dockerignore no longer matches the reviewed build-context contract")

    records: list[str] = []
    for directory, names, files in os.walk(root, topdown=True, followlinks=False):
        directory_path = Path(directory)
        relative_directory = directory_path.relative_to(root).as_posix()

        kept_directories = []
        for name in sorted(names):
            relative = name if relative_directory == "." else f"{relative_directory}/{name}"
            if relative in IGNORED_DIRECTORIES:
                continue
            candidate = directory_path / name
            metadata = candidate.lstat()
            if stat.S_ISLNK(metadata.st_mode):
                target = os.readlink(candidate)
                records.append(
                    f"link|{stat.S_IMODE(metadata.st_mode):04o}|"
                    f"{hashlib.sha256(target.encode()).hexdigest()}|{relative}\n"
                )
                continue
            records.append(f"directory|{stat.S_IMODE(metadata.st_mode):04o}|-|{relative}\n")
            kept_directories.append(name)
        names[:] = kept_directories

        for name in sorted(files):
            if ignored_file(name):
                continue
            candidate = directory_path / name
            relative = name if relative_directory == "." else f"{relative_directory}/{name}"
            metadata = candidate.lstat()
            if stat.S_ISLNK(metadata.st_mode):
                content_digest = hashlib.sha256(os.readlink(candidate).encode()).hexdigest()
                kind = "link"
            elif stat.S_ISREG(metadata.st_mode):
                content_digest = digest_file(candidate)
                kind = "file"
            else:
                fail(f"unsupported build-context entry: {relative}")
            records.append(f"{kind}|{stat.S_IMODE(metadata.st_mode):04o}|{content_digest}|{relative}\n")

    aggregate = hashlib.sha256()
    for record in sorted(records):
        aggregate.update(record.encode())
    print(aggregate.hexdigest())


if __name__ == "__main__":
    main()
