import type { TowingFields } from "@/domain/towing/types";
import styles from "./towing.module.css";

export function TowingParties({ fields }: { fields: TowingFields }) {
  return <dl className={styles.muted}>{fields.requester?.name && <div><dt>Objednávateľ</dt><dd>{fields.requester.name}{fields.requester.phone ? ` · ${fields.requester.phone}` : ""}</dd></div>}{fields.customer?.name && <div><dt>Odberateľ</dt><dd>{fields.customer.name}</dd></div>}{(fields.assistanceReference || fields.assistancePartnerName) && <div><dt>Asistencia</dt><dd>{[fields.assistancePartnerName, fields.assistanceReference].filter(Boolean).join(" · ")}</dd></div>}</dl>;
}
