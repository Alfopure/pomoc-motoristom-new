import { createRoot } from "react-dom/client";
import { CallRecordingDetail } from "../../src/components/dispatch/recordings/CallRecordingDetail";

createRoot(document.getElementById("root")!).render(<CallRecordingDetail callId="fixture-call" />);
