#!/usr/bin/env node

import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { parseRuntimeEnv } from "./runtime-env-parser.mjs";

const target = process.argv[2] ?? "web";
const secretPath = "/run/secrets/runtime_env";
const maximumSecretBytes = 1024 * 1024;
const secret = await open(secretPath, constants.O_RDONLY | constants.O_NOFOLLOW);
let contents;

try {
  const metadata = await secret.stat();
  if (!metadata.isFile() || metadata.nlink !== 1) {
    throw new Error("Runtime secret must be a single regular file.");
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error("Runtime secret must not be accessible by group or other users.");
  }
  if (metadata.size > maximumSecretBytes) {
    throw new Error("Runtime secret exceeds the maximum allowed size.");
  }
  contents = await secret.readFile({ encoding: "utf8" });
} finally {
  await secret.close();
}

const runtime = parseRuntimeEnv(contents);

for (const [key, value] of Object.entries(runtime)) {
  if (Object.hasOwn(process.env, key)) {
    if (process.env[key] !== value) {
      throw new Error(`Runtime variable ${key} conflicts with the Docker secret.`);
    }
    continue;
  }
  process.env[key] = value;
}

if (typeof process.getuid === "function" && process.getuid() === 0) {
  process.setgroups?.([]);
  process.setgid(1001);
  process.setuid(1001);
}
if (typeof process.getuid === "function" && process.getuid() !== 1001) {
  throw new Error("Runtime did not drop to the application user.");
}

if (target === "web") {
  await import("./server.js");
} else if (target === "worker") {
  await import("./worker.mjs");
} else if (target === "one-shot") {
  await import("./one-shot.mjs");
} else if (target === "viptel-listener") {
  await import("./viptel-listener.mjs");
} else {
  throw new Error(`Unknown runtime target: ${target}`);
}
