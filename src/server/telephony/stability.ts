/** Creation is enabled only after the shared database and every writer are compatible. */
export function telephonyStabilityEnabled(): boolean {
  return process.env.TELEPHONY_STABILITY_V1_ENABLED === "true";
}

export function hasStabilityContract(session: { pending_effects?: unknown; metadata?: unknown; presence_pickup?: unknown }): boolean {
  const meta = session.metadata;
  return Boolean(session.pending_effects || session.presence_pickup || meta && typeof meta === "object" && "effects_v1" in meta);
}
