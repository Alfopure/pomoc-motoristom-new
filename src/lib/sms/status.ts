export function smsStatusLabel(status: string, detail?: string | null) {
  if (detail === "send_unconfirmed" || detail === "sending_to_provider") return "Výsledok odoslania sa overuje";
  if (detail === "delivery_unconfirmed") return "Doručenie nepotvrdené";
  return ({ queued: "Vo fronte", sent: "Odoslaná operátorovi", delivered: "Doručená", failed: "Zlyhala", received: "Prijatá" } as Record<string, string>)[status] ?? "Neznámy stav";
}

export function locationRequestLabel(status: string) {
  return ({ prepared: "Pripravená", active: "Čaká na polohu", used: "Poloha prijatá", expired: "Link vypršal", revoked: "Zrušená" } as Record<string, string>)[status] ?? "Neznámy stav žiadosti";
}
