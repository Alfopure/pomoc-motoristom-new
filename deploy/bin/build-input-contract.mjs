#!/usr/bin/env node

import { createHash } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const BUILD_ARGUMENT_KEYS = [
  "DEPLOYMENT_VERSION",
  "NEXT_PUBLIC_APP_URL",
  "NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY",
  "NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
  "NEXT_PUBLIC_SUPABASE_URL",
];

function fail(message) {
  throw new Error(message);
}

function canonicalPayload(buildArgs) {
  return `${JSON.stringify({ schemaVersion: 1, buildArgs })}\n`;
}

function digest(payload) {
  return createHash("sha256").update(payload).digest("hex");
}

function requirePrivateRegularFile(path) {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    fail("build-input contract must be a private regular file");
  }
}

function readContract(path) {
  requirePrivateRegularFile(path);
  const payload = readFileSync(path, "utf8");
  const parsed = JSON.parse(payload);
  if (parsed?.schemaVersion !== 1 || typeof parsed.buildArgs !== "object" || parsed.buildArgs === null) {
    fail("build-input contract schema is invalid");
  }
  const keys = Object.keys(parsed.buildArgs).sort();
  if (JSON.stringify(keys) !== JSON.stringify(BUILD_ARGUMENT_KEYS)) {
    fail("build-input contract keys are invalid");
  }
  if (Object.values(parsed.buildArgs).some((value) => typeof value !== "string" || /[\r\n\0]/.test(value))) {
    fail("build-input contract value is invalid");
  }
  if (payload !== canonicalPayload(parsed.buildArgs)) fail("build-input contract is not canonical");
  return { payload, buildArgs: parsed.buildArgs };
}

function validateIdentity(buildArgs, version, targetRef, appDomain, runtime = null) {
  const targetUrl = `https://${targetRef}.supabase.co`;
  if (!/^hetzner-[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(version) || version.includes("..")) {
    fail("release version is invalid");
  }
  if (!/^[a-z0-9]{20}$/.test(targetRef)) fail("target project ref is invalid");
  if (buildArgs.DEPLOYMENT_VERSION !== version) fail("build release version mismatch");
  if (buildArgs.NEXT_PUBLIC_APP_URL !== `https://${appDomain}`) fail("build app URL mismatch");
  if (buildArgs.NEXT_PUBLIC_SUPABASE_URL !== targetUrl) fail("build Supabase URL mismatch");
  if (!buildArgs.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) fail("build publishable key is missing");
  if (buildArgs.NEXT_PUBLIC_SUPABASE_ANON_KEY !== buildArgs.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY) {
    fail("build public Supabase aliases differ");
  }
  if (runtime) {
    for (const key of [
      "NEXT_PUBLIC_SUPABASE_URL",
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    ]) {
      if (buildArgs[key] !== runtime[key]) fail(`build/runtime mismatch for ${key}`);
    }
  }
}

function parseRuntimeEnv(path) {
  requirePrivateRegularFile(path);
  const parsed = {};
  for (const [index, line] of readFileSync(path, "utf8").split(/\r?\n/).entries()) {
    if (!line) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) fail(`runtime env line ${index + 1} is invalid`);
    const key = line.slice(0, separator);
    if (Object.hasOwn(parsed, key)) fail(`runtime env has duplicate ${key}`);
    parsed[key] = JSON.parse(line.slice(separator + 1));
  }
  return parsed;
}

function writeContract(path, version, targetRef, appDomain) {
  const buildArgs = Object.fromEntries(BUILD_ARGUMENT_KEYS.map((key) => [key, process.env[key] ?? ""]));
  validateIdentity(buildArgs, version, targetRef, appDomain);
  const payload = canonicalPayload(buildArgs);
  const descriptor = openSync(path, "wx", 0o600);
  try {
    writeFileSync(descriptor, payload, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  return digest(payload);
}

function main() {
  const { positionals } = parseArgs({ allowPositionals: true, strict: true });
  const [command, path, version, targetRef, appDomain, runtimePath] = positionals;
  if (command === "write" && positionals.length === 5) {
    console.log(writeContract(path, version, targetRef, appDomain));
    return;
  }
  if (command === "validate" && positionals.length === 6) {
    const { payload, buildArgs } = readContract(path);
    validateIdentity(buildArgs, version, targetRef, appDomain, parseRuntimeEnv(runtimePath));
    console.log(digest(payload));
    return;
  }
  fail("usage: build-input-contract.mjs write PATH VERSION TARGET_REF APP_DOMAIN | validate PATH VERSION TARGET_REF APP_DOMAIN RUNTIME_ENV");
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
