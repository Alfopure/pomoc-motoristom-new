import "server-only";

import { createHash } from "node:crypto";

import {
  createViptelClient,
  getViptelConfig,
  type ViptelActiveCall,
  type ViptelExtension,
  type ViptelQueueStatus,
} from "@/lib/integrations/viptel/client";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { resolveDefaultOrganizationId } from "@/server/default-organization";
import { persistViptelEvent } from "@/server/telephony/viptel-events";
import {
  confirmTelephonyCommandsFromViptelEvent,
  ViptelCommandOutbox,
} from "@/server/telephony/viptel-command-outbox";
import { reconcileViptelCalls } from "@/server/telephony/viptel-reconcile";
import {
  createCoverageStabilityTracker,
  reconcileDispatchQueueCoverage,
} from "@/server/telephony/dispatch-coverage-reconciler";
import { enqueueDueViptelFallbackRedirects } from "@/server/telephony/fallback-routing";
import { interruptibleDelay } from "./interruptible-delay";
import { safeErrorMessage } from "./redaction";
import { RunLedger } from "./run-ledger";
import { SerializedOperation } from "./serialized-operation";

const HEARTBEAT_MS = 30_000;
const LOGIN_TIMEOUT_MS = 20_000;
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const COMMAND_POLL_MS = 750;
const FALLBACK_POLL_MS = 2_000;

type ListenerStatus = "disabled" | "connecting" | "connected" | "reconnecting" | "draining";

export class ViptelListener {
  private readonly enabled = process.env.VIPTEL_LISTENER_ENABLED?.trim().toLowerCase() === "true";
  private readonly deploymentVersion = process.env.DEPLOYMENT_VERSION?.trim() || "development";
  private readonly instanceId = process.env.VIPTEL_LISTENER_INSTANCE_ID?.trim() || "motorist-prod-01-viptel";
  private readonly ledger = new RunLedger();
  private status: ListenerStatus = this.enabled ? "connecting" : "disabled";
  private socket: WebSocket | null = null;
  private stopping = false;
  private lastEventAt: string | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private commandTimer: NodeJS.Timeout | null = null;
  private fallbackTimer: NodeJS.Timeout | null = null;
  private processing = Promise.resolve();
  private readonly heartbeatQueue = new SerializedOperation();
  private readonly commandQueue = new SerializedOperation();
  private readonly fallbackQueue = new SerializedOperation();
  /**
   * Coverage change detection lives in memory, not the database, so there is no
   * row to contend with the manager routing saga and nothing to repair after a
   * restart -- a fresh process simply re-derives from the next snapshot.
   */
  private readonly coverageStability = createCoverageStabilityTracker();
  private readonly stopController = new AbortController();

  async start() {
    this.installSignalHandlers();
    await this.heartbeat();
    this.heartbeatTimer = setInterval(() => void this.heartbeat().catch((error) => log("heartbeat_failed", { error: safeErrorMessage(error) })), HEARTBEAT_MS);

    if (!this.enabled) {
      log("listener_disabled", { instanceId: this.instanceId });
      await this.waitForStop();
      await this.terminalHeartbeat();
      return;
    }

    let failures = 0;
    while (!this.stopping) {
      this.status = failures === 0 ? "connecting" : "reconnecting";
      await this.heartbeat().catch((error) => {
        log("heartbeat_failed", { error: safeErrorMessage(error) });
      });
      try {
        await this.connectOnce();
        failures = 0;
      } catch (error) {
        failures += 1;
        log("connection_failed", { attempt: failures, error: safeErrorMessage(error) });
      }

      if (!this.stopping) {
        await interruptibleDelay(backoffMs(failures), this.stopController.signal);
      }
    }

    await this.processing;
    this.clearHeartbeat();
    await this.terminalHeartbeat();
    log("listener_stopped", { instanceId: this.instanceId });
  }

  private async connectOnce() {
    const config = getViptelConfig();
    const organizationId = await resolveDefaultOrganizationId();
    const client = createSupabaseAdminClient();
    const viptel = createViptelClient(config);
    const outbox = new ViptelCommandOutbox(client, organizationId, this.instanceId);

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(config.websocketUrl);
      this.socket = socket;
      let loggedIn = false;
      let settled = false;
      const loginTimeout = setTimeout(() => closeWithError(new Error("VIPTel login timed out.")), LOGIN_TIMEOUT_MS);

      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(loginTimeout);
        this.clearCommandPump();
        this.clearFallbackPump();
        if (this.socket === socket) this.socket = null;
        if (error) reject(error);
        else resolve();
      };

      const closeWithError = (error: Error) => {
        try {
          socket.close();
        } finally {
          finish(error);
        }
      };

      socket.addEventListener("open", () => {
        log("socket_open", { endpoint: safeEndpoint(config.websocketUrl) });
      });

      socket.addEventListener("message", (message) => {
        this.processing = this.processing
          .then(async () => {
            const text = await messageText(message.data);
            if (Buffer.byteLength(text, "utf8") > MAX_MESSAGE_BYTES) {
              throw new Error("VIPTel WebSocket message exceeds the allowed size.");
            }
            const payload = parsePayload(text);
            if (!payload) return;
            const record = asRecord(payload);

            if (!loggedIn) {
              const nonce = readString(record.nonce);
              if (nonce) {
                socket.send(JSON.stringify({
                  action: "user.login",
                  username: config.username,
                  password: loginHash(config.username, config.password, nonce),
                }));
                return;
              }

              const code = Number(record.code);
              if (code === 202) {
                loggedIn = true;
                clearTimeout(loginTimeout);
                this.status = "connected";
                await this.heartbeat();
                await pingHealthcheck(process.env.VIPTEL_HEALTHCHECKS_PING_URL);
                log("login_succeeded", { code });
                if (envEnabled("VIPTEL_RECONCILE_ON_CONNECT", true)) {
                  await reconcileViptelCalls();
                  log("reconcile_completed", { trigger: "connect" });
                }
                this.startCommandPump(outbox, socket, viptel);
                this.startFallbackPump(client, organizationId, socket, viptel);
                return;
              }

              if (Number.isFinite(code)) {
                closeWithError(new Error(`VIPTel login rejected with code ${code}.`));
              }
              return;
            }

            const code = Number(record.code);
            if (Number.isFinite(code) && code >= 400) {
              const handled = await outbox.handleProviderResponse(payload);
              log("command_provider_response", { code, matchedCommand: handled });
              if (code >= 500) {
                closeWithError(new Error(`VIPTel service returned code ${code}.`));
              }
              return;
            }

            const receivedAt = new Date().toISOString();
            const result = await persistViptelEvent(client, organizationId, payload, receivedAt);
            const confirmedCommandIds = await confirmTelephonyCommandsFromViptelEvent(client, organizationId, payload, {
              callId: result.callId,
              eventFingerprint: result.fingerprint,
              receivedAt,
            });
            outbox.noteConfirmed(confirmedCommandIds);
            this.lastEventAt = receivedAt;
            await this.heartbeat();
            log("event_persisted", {
              eventType: result.eventType,
              duplicate: result.duplicate,
              handled: result.handled,
              confirmedCommands: confirmedCommandIds.length,
            });
          })
          .catch((error) => {
            log("message_failed", { error: safeErrorMessage(error) });
          });
      });

      socket.addEventListener("error", () => {
        closeWithError(new Error("VIPTel WebSocket transport error."));
      });

      socket.addEventListener("close", (event) => {
        const expected = this.stopping || event.code === 1000;
        finish(expected ? undefined : new Error(`VIPTel WebSocket closed with code ${event.code}.`));
      });
    });
  }

  private async heartbeat(stoppedStatus?: "disabled") {
    return this.heartbeatQueue.run(() => this.writeHeartbeat(stoppedStatus));
  }

  private startCommandPump(
    outbox: ViptelCommandOutbox,
    socket: WebSocket,
    viptel: ReturnType<typeof createViptelClient>,
  ) {
    this.clearCommandPump();
    const dispatch = () =>
      this.commandQueue.run(async () => {
        if (this.stopping || socket.readyState !== WebSocket.OPEN) return;
        const result = await outbox.dispatchNext(socket, viptel);
        if (result) {
          log("command_dispatched", {
            commandId: result.commandId,
            commandType: result.commandType,
            transport: result.transport,
          });
        }
      }).catch((error) => log("command_dispatch_failed", { error: safeErrorMessage(error) }));

    void dispatch();
    this.commandTimer = setInterval(() => void dispatch(), COMMAND_POLL_MS);
  }

  private async writeHeartbeat(stoppedStatus?: "disabled") {
    await this.ledger.heartbeat({
      workerId: this.instanceId,
      deploymentVersion: this.deploymentVersion,
      schedulerStatus: "listener",
      schedulerTickAt: null,
      viptelWsStatus: stoppedStatus ?? (this.stopping ? "draining" : this.status),
      lastViptelEventAt: this.lastEventAt,
    });
    if (this.status === "connected" && !this.stopping) {
      await pingHealthcheck(process.env.VIPTEL_HEALTHCHECKS_PING_URL);
    }
  }

  private async terminalHeartbeat() {
    await this.heartbeat("disabled").catch((error) => {
      log("terminal_heartbeat_failed", { error: safeErrorMessage(error) });
    });
  }

  private installSignalHandlers() {
    const stop = () => {
      if (this.stopping) return;
      this.stopping = true;
      this.status = "draining";
      this.stopController.abort();
      this.socket?.close(1000, "shutdown");
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
  }

  private waitForStop() {
    return new Promise<void>((resolve) => {
      const finish = () => {
        this.clearHeartbeat();
        resolve();
      };
      if (this.stopController.signal.aborted) {
        finish();
        return;
      }
      this.stopController.signal.addEventListener("abort", finish, { once: true });
    });
  }

  private clearHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
  }

  private startFallbackPump(
    client: ReturnType<typeof createSupabaseAdminClient>,
    organizationId: string,
    socket: WebSocket,
    viptel: ReturnType<typeof createViptelClient>,
  ) {
    this.clearFallbackPump();
    type AvailabilitySnapshot = {
      activeCalls: ViptelActiveCall[];
      extensions: ViptelExtension[];
      queueStatuses: ViptelQueueStatus[];
    };
    let availabilityCache: {
      expiresAt: number;
      value: AvailabilitySnapshot;
    } | null = null;
    const loadAvailability = async (): Promise<AvailabilitySnapshot> => {
      const now = Date.now();
      if (availabilityCache && availabilityCache.expiresAt > now) {
        return availabilityCache.value;
      }
      const [activeCalls, extensions, queueStatuses] = await Promise.all([
        viptel.listActiveCalls(),
        viptel.listExtensions(),
        Promise.all(["601", "602", "603"].map((queue) => viptel.getQueueStatus(queue))),
      ]);
      const value = { activeCalls, extensions, queueStatuses };
      availabilityCache = { expiresAt: now + 4_000, value };
      return value;
    };
    const dispatch = () => this.fallbackQueue.run(async () => {
      if (this.stopping || socket.readyState !== WebSocket.OPEN) return;
      const snapshot = await loadAvailability();

      // Ring coverage is reconciled before the fallback decision and on the
      // same snapshot, so "nobody online -> every queue empty -> fallback"
      // converges within one tick instead of two. Its failures are contained:
      // a coverage problem must never stop the fallback pump, which is the
      // safety net for a caller nobody has answered.
      try {
        const coverage = await reconcileDispatchQueueCoverage({
          organizationId,
          snapshot,
          stability: this.coverageStability,
          client,
        });
        if (coverage.status !== "matched" && coverage.status !== "disabled" && coverage.status !== "unstable") {
          log("dispatch_coverage_tick", coverage);
        }
      } catch (error) {
        log("dispatch_coverage_failed", { error: safeErrorMessage(error) });
      }

      const result = await enqueueDueViptelFallbackRedirects(
        client,
        organizationId,
        new Date(),
        async () => snapshot,
      );
      if (result.enqueued > 0) {
        log("fallback_redirect_enqueued", result);
      }
    }).catch((error) => log("fallback_redirect_failed", { error: safeErrorMessage(error) }));
    void dispatch();
    this.fallbackTimer = setInterval(() => void dispatch(), FALLBACK_POLL_MS);
  }

  private clearCommandPump() {
    if (this.commandTimer) clearInterval(this.commandTimer);
    this.commandTimer = null;
  }

  private clearFallbackPump() {
    if (this.fallbackTimer) clearInterval(this.fallbackTimer);
    this.fallbackTimer = null;
  }
}

export function loginHash(username: string, password: string, nonce: string) {
  const first = createHash("sha1").update(`${username}:${password}`, "utf8").digest("hex");
  return createHash("sha1").update(`${first}:${nonce}`, "utf8").digest("hex");
}

export function backoffMs(failures: number, random = Math.random()) {
  const exponential = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** Math.max(0, failures - 1));
  return Math.round(exponential * (0.75 + Math.max(0, Math.min(1, random)) * 0.5));
}

async function messageText(data: unknown) {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.text();
  return String(data);
}

function parsePayload(text: string) {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readString(value: unknown) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function safeEndpoint(value: string) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "configured";
  }
}

function envEnabled(name: string, fallback: boolean) {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  return value === "true";
}

async function pingHealthcheck(value: string | undefined) {
  const url = value?.trim();
  if (!url) return;
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Healthcheck ping failed with HTTP ${response.status}.`);
}

function log(event: string, fields: Record<string, unknown>) {
  const error = event.endsWith("failed") || event === "connection_failed";
  console.log(JSON.stringify({ level: error ? "error" : "info", event: `viptel_${event}`, ...fields }));
}
