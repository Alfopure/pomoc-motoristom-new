#!/usr/bin/env node
/**
 * Isolation guard for this copy of the dispatch application.
 *
 * The original production project must never be reached from here (AGENTS.md).
 * This script inspects the runtime/build environment and fails hard when any
 * database or application URL points at the original project. It runs before
 * `next build` and can be invoked manually: `node scripts/assert-target-project.mjs`.
 */

// Identifiers of the original production project. They are listed here only so
// that they can be refused; nothing in this repository may use them otherwise.
const FORBIDDEN_FRAGMENTS = [
  "sjcsrygkkmersoczpunh",
  "pomoc-motoristom-dispecing.vercel.app",
  "dispecing.linkapomoci.sk",
];

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
    for (const fragment of FORBIDDEN_FRAGMENTS) {
      if (value.includes(fragment)) {
        problems.push(`${key} points at the original production project (${fragment})`);
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
