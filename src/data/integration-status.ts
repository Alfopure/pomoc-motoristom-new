import type { IntegrationConnection } from "./dispatch-types";

/**
 * Odvodí efektívny status integrácie pre zobrazenie v UI.
 *
 * "configured" = env credentials sú provisioned; "live" je REZERVOVANÉ pre reálny
 * sync/heartbeat (GPS syncy `webdispecink-sync`/`commander/sync` nastavujú "live"
 * až po úspešnom syncu). Telefónne integrácie (viptel/viptel_sms) nemajú writer
 * statusu, takže ich DB riadok ostáva "not_configured" — `secretConfigured`
 * (počítané z env) je ich pravý readiness signál. Odvodzujeme tu, v zdroji
 * (`mapIntegrationConnection`), nech všetky views (Napojenia badge + CallCenter
 * chip) súhlasia. Prípadný neskorší reálny "live" writer prirodzene prebije —
 * flip sa spúšťa len keď je raw status "not_configured".
 */
export function deriveEffectiveIntegrationStatus(
  rawStatus: IntegrationConnection["status"],
  secretConfigured: boolean,
): IntegrationConnection["status"] {
  return rawStatus === "not_configured" && secretConfigured ? "configured" : rawStatus;
}
