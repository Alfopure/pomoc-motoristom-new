#!/usr/bin/env node
/**
 * Isolation guard for this copy of the dispatch application.
 *
 * The original production project must never be reached from here (AGENTS.md).
 * This script inspects the runtime/build environment and fails hard when any
 * database or application URL points at the original project. It runs before
 * `next build` and can be invoked manually: `node scripts/assert-target-project.mjs`.
 */

// Identifiers of the retired VIPTel project. They are listed here only so that
// they can be refused; nothing in this repository may use them otherwise.
const FORBIDDEN_FRAGMENTS = [
  "sjcsrygkkmersoczpunh",
  "pomoc-motoristom-dispecing.vercel.app",
  "pomoc-motoristom-dispatching-old.vercel.app",
];

// Hostnames the retired application still answers on. Matched on the parsed
// hostname rather than as a substring, because `dev.dispecing.linkapomoci.sk`
// contains this project's own domain and a substring test would refuse it.
const RETIRED_HOSTNAMES = ["dev.dispecing.linkapomoci.sk"];

const INSPECTED_KEYS = [
  "SUPABASE_PROJECT_REF",
  "SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_DB_URL",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "POSTGRES_URL_NON_POOLING",
  "POSTGRES_HOST",
  "APP_BASE_URL",
  "NEXT_PUBLIC_APP_URL",
  "PUBLIC_APP_URL",
];

export function assertTargetProject(env = process.env) {
  const problems = [];

  for (const key of INSPECTED_KEYS) {
    const value = env[key];
    if (!value) continue;
    let url;
    try {
      url = new URL(value);
    } catch {
      // Project refs and bare database hosts are also inspected values.
    }
    const normalizedValue = `${value} ${url?.href ?? ""}`.toLowerCase();
    for (const fragment of FORBIDDEN_FRAGMENTS) {
      if (normalizedValue.includes(fragment)) {
        problems.push(`${key} points at the original production project (${fragment})`);
      }
    }
    // `dispecing.linkapomoci.sk` used to be refused here. The owner moved it to
    // this project on 2026-09-21, so refusing it would now fail the build for
    // pointing at our own production domain.
    // Checked twice: as a parsed hostname, and as a substring so the name
    // cannot be smuggled through user-info or a redirect parameter. A
    // substring test is safe in this direction because the retired hostname
    // contains this project's domain and never the other way round.
    const hostname = url?.hostname.toLowerCase();
    for (const retired of RETIRED_HOSTNAMES) {
      if (hostname === retired || normalizedValue.includes(retired)) {
        problems.push(`${key} points at the retired VIPTel project (${retired})`);
        break;
      }
    }
  }

  const expectedRef = env.EXPECTED_SUPABASE_PROJECT_REF?.trim();
  const actualRef = env.SUPABASE_PROJECT_REF?.trim();
  if (expectedRef && actualRef && expectedRef !== actualRef) {
    problems.push(`SUPABASE_PROJECT_REF (${actualRef}) differs from EXPECTED_SUPABASE_PROJECT_REF (${expectedRef})`);
  }

  return problems;
}

const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (invokedDirectly) {
  const problems = assertTargetProject();
  if (problems.length > 0) {
    console.error("assert-target-project: refusing to continue");
    for (const problem of problems) console.error(` - ${problem}`);
    process.exit(1);
  }
  console.log("assert-target-project: ok");
}
