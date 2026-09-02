import "server-only";

import type { JobContext } from "@/server/jobs/types";
import {
  failedOneShotOutput,
  oneShotOutput,
  parseOneShotRequest,
  safeJobFromArguments,
  serializeOneShotOutput,
  type OneShotOutput,
} from "./one-shot-contract";

const argv = process.argv.slice(3);
const writeResult = process.stdout.write.bind(process.stdout);
silenceProcessOutput();

void executeOneShot(argv)
  .then((output) => finish(output, writeResult))
  .catch(() => finish(failedOneShotOutput(safeJobFromArguments(argv)), writeResult));

async function executeOneShot(arguments_: readonly string[]): Promise<OneShotOutput> {
  const request = parseOneShotRequest(arguments_, process.env);
  const { jobDefinition } = await import("@/server/jobs/registry");
  const definition = jobDefinition(request.job);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), definition.timeoutMs);
  const context: JobContext = {
    runId: `one-shot-${request.job}`,
    scheduledFor: new Date().toISOString(),
    signal: controller.signal,
  };

  if (request.job.startsWith("fleet.webdispecink.")) {
    process.env.WEBDISPECINK_SYNC_ENABLED = "true";
  }

  try {
    const result = await definition.run(context, request.payload as never);
    if (controller.signal.aborted) throw new Error("one-shot job timed out");
    return oneShotOutput(request.job, result.status, result.summarySafe);
  } finally {
    clearTimeout(timeout);
  }
}

function finish(output: OneShotOutput, write: (chunk: string) => boolean) {
  write(serializeOneShotOutput(output));
  if (!output.ok) process.exitCode = 1;
}

function silenceProcessOutput() {
  const discard = (() => true) as typeof process.stdout.write;
  process.stdout.write = discard;
  process.stderr.write = discard as typeof process.stderr.write;
}
