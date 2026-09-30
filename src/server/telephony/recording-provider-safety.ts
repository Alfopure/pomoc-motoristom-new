import "server-only";
import { record, RecordingProcessingError, type RecordingJobContext } from "./recording-jobs";
import { getTelnyxConfig } from "./telnyx/env";
import { getTestProviderSafety } from "./telnyx/test-safety";

/**
 * Copied rows never authorize provider audio access. Returns verified TEST
 * metadata, null for confirmed absence, or undefined for the production path.
 */
export async function assertRecordingProviderAccess(ctx: RecordingJobContext, operation: "import" | "delete"): Promise<Record<string, unknown> | null | undefined> {
  const safety = getTestProviderSafety();
  if (!safety.restricted) return;
  const denied = () => new RecordingProcessingError("test_recording_provider_boundary");
  if (!safety.deploymentAllowed || (operation === "import" && !safety.enabled)) throw denied();
  const config = getTelnyxConfig();
  const recording = ctx.recording;
  if (!config.configured || !config.callControlAppId || !config.credentialConnectionId ||
    config.callControlAppId === config.credentialConnectionId || !recording?.provider_recording_id ||
    recording.organization_id !== ctx.organizationId) throw denied();
  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(1500)]);
  // Metadata has no audio bytes. Telnyx returns the owning connection here,
  // so proof survives the shorter webhook-ledger retention window.
  const response = await fetch(`https://api.telnyx.com/v2/recordings/${encodeURIComponent(recording.provider_recording_id)}`, {
    headers: { Authorization: `Bearer ${config.apiKey}` }, signal, cache: "no-store", redirect: "error",
  });
  if (response.status === 404 && operation === "delete") { await response.body?.cancel(); return null; }
  if (!response.ok) { await response.body?.cancel(); throw denied(); }
  const data = record(record(await response.json()).data);
  if (data.id !== recording.provider_recording_id ||
    (data.connection_id !== config.callControlAppId && data.connection_id !== config.credentialConnectionId) ||
    (recording.provider_session_id && data.call_session_id !== recording.provider_session_id)) throw denied();
  return data;
}
