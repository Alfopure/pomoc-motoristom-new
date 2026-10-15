"use client";

import { useEffect } from "react";
import { recordDiagnostic } from "@/lib/diagnostics/client";
import { startupDiagnostics } from "@/lib/diagnostics/startup";

export function StartupDiagnostics() {
  useEffect(() => {
    try {
      startupDiagnostics.ready();
      startupDiagnostics.publish(recordDiagnostic);
    } catch { /* Startup must never depend on telemetry. */ }
  }, []);
  return null;
}
