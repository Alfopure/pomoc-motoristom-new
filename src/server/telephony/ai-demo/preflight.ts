import { openAILiveClient, OpenAILiveError } from "@/lib/integrations/ai/openai-live";

import { countToday, loadActive, migrationApplied } from "./attempts";
import { aiDemoBudgets, aiDemoEnabled, getAiDemoConfig, AI_DEMO_ALLOWED_VOICES, AI_DEMO_LIMITS, AI_DEMO_NATURAL_VOICES } from "./config";
import { webSocketAvailable } from "./greeting";
import { describeAttempt, type AiDemoDeps } from "./orchestrator";

/**
 * Read-only readiness check.
 *
 * Nothing here can create a call or a paid session, and that property is worth
 * more than any single field it returns: it is the difference between "we
 * checked" and "we tried". The local half touches only this deployment's own
 * environment and database; `?remote=1` adds exactly three provider GETs.
 *
 * It answers names, booleans and identifiers — never a secret, never a full
 * phone number.
 */

export type AiDemoPreflight = Awaited<ReturnType<typeof runAiDemoPreflight>>;

export async function runAiDemoPreflight(deps: AiDemoDeps, options: { remote: boolean }) {
  const env = deps.env ?? process.env;
  const enabled = aiDemoEnabled(env);
  const config = getAiDemoConfig(env);

  let migration = false;
  let activeAttempt: ReturnType<typeof describeAttempt> | null = null;
  let attemptsToday = 0;
  try {
    migration = await migrationApplied(deps.admin);
    if (migration) {
      const active = await loadActive(deps.admin, deps.organizationId);
      activeAttempt = active ? describeAttempt(active) : null;
      const midnight = new Date(deps.now ? deps.now() : new Date());
      midnight.setUTCHours(0, 0, 0, 0);
      attemptsToday = await countToday(deps.admin, deps.organizationId, midnight);
    }
  } catch (error) {
    deps.logger?.({ level: "warn", scope: "ai-demo", message: "preflight database read failed", error: error instanceof Error ? error.message : String(error) });
  }

  const fromNumber = config.configured ? config.fromNumber : null;
  let fromLineActive = false;
  if (fromNumber) {
    const line = await deps.admin
      .from("motorist_telephony_lines")
      .select("id")
      .eq("organization_id", deps.organizationId)
      .eq("phone_number", fromNumber)
      .eq("active", true)
      .maybeSingle();
    fromLineActive = Boolean(line.data);
  }

  const settings = await deps.admin
    .from("motorist_telephony_settings")
    .select("live_calls_enabled, destination_allowlist")
    .eq("organization_id", deps.organizationId)
    .maybeSingle();

  const base = {
    enabled,
    configured: config.configured,
    missing: config.configured ? [] : config.missing,
    fromNumber,
    fromLineActive,
    recipientCount: config.configured ? config.allowedRecipients.length : 0,
    node: process.version,
    webSocketGlobal: webSocketAvailable(),
    deployedEnvironment: deps.environment,
    telnyx: {
      configured: deps.config.configured,
      liveCallsEnv: deps.config.configured ? deps.config.liveCallsEnabled : false,
      liveCallsDb: settings.data?.live_calls_enabled === true,
      destinationAllowlist: (settings.data?.destination_allowlist as string[] | null) ?? [],
      callControlAppId: deps.config.configured ? deps.config.callControlAppId : null,
    },
    db: { migrationApplied: migration, activeAttempt, attemptsToday },
    limits: config.configured
      ? { ...aiDemoBudgets(config), maxAttemptsPerDay: config.maxAttemptsPerDay, ringTimeoutSeconds: config.ringTimeoutSeconds, maxCallSeconds: config.maxCallSeconds }
      : null,
    model: config.configured ? { live: config.model, backend: config.backendModel, voice: config.voice, sipHost: config.sipHost } : null,
    voices: { all: AI_DEMO_ALLOWED_VOICES, natural: AI_DEMO_NATURAL_VOICES },
    probeBudgetMs: AI_DEMO_LIMITS.probeWindowMs,
    webhookUrl: config.configured ? config.webhookUrl : null,
    remote: null as null | RemotePreflight,
  };

  if (!options.remote || !config.configured) return base;
  return { ...base, remote: await runRemotePreflight(deps, config) };
}

export type RemotePreflight = {
  models: { liveAvailable: boolean; error: string | null };
  did: { phoneNumber: string | null; connectionId: string | null; onThisApp: boolean | null; status: string | null; error: string | null };
};

/**
 * The three provider reads worth doing before a live test.
 *
 * `gpt-live-1` in the model list proves the key works and the model exists; it
 * does **not** prove SIP is enabled for the project, which has no documented
 * check at all. `onThisApp` answers the one question that silently breaks a
 * test on a preview alias: whether the DID is attached to the Call Control
 * application this deployment is configured with.
 */
async function runRemotePreflight(deps: AiDemoDeps, config: Extract<ReturnType<typeof getAiDemoConfig>, { configured: true }>): Promise<RemotePreflight> {
  const result: RemotePreflight = {
    models: { liveAvailable: false, error: null },
    did: { phoneNumber: null, connectionId: null, onThisApp: null, status: null, error: null },
  };

  try {
    const client = openAILiveClient({
      apiKey: config.apiKey,
      signal: AbortSignal.timeout(8_000),
      ...(deps.openAIFetch ? { fetch: deps.openAIFetch } : {}),
    });
    result.models.liveAvailable = (await client.listModels()).includes(config.model);
  } catch (error) {
    result.models.error = error instanceof OpenAILiveError ? error.code : "openai_unreachable";
  }

  if (deps.telnyx) {
    try {
      const numbers = await deps.telnyx.listPhoneNumbers({ phoneNumber: config.fromNumber, pageSize: 1 });
      const did = numbers[0] ?? null;
      if (did) {
        const appId = deps.config.configured ? deps.config.callControlAppId : null;
        result.did = {
          phoneNumber: did.phoneNumber ?? null,
          connectionId: did.connectionId ?? null,
          onThisApp: appId !== null && did.connectionId !== null ? did.connectionId === appId : null,
          status: did.status ?? null,
          error: null,
        };
      } else {
        result.did.error = "did_not_found";
      }
    } catch (error) {
      result.did.error = error instanceof Error ? error.message.slice(0, 120) : "telnyx_unreachable";
    }
  }

  return result;
}
