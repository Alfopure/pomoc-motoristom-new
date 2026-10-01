import { createRoot } from "react-dom/client";
import { MonitorScreen } from "@/components/monitor/MonitorScreen";

createRoot(document.getElementById("root")!).render(<MonitorScreen appVersion="monitor-fixture-build" identity={{ organizationId: "00000000-0000-4000-8000-000000000001", profileId: "00000000-0000-4000-8000-000000000002" }} />);
