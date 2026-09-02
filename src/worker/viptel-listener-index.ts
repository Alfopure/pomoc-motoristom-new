import "server-only";

import { ViptelListener } from "./viptel-listener";

const listener = new ViptelListener();

listener.start().catch((error) => {
  const message = error instanceof Error ? error.message : "VIPTel listener failed.";
  console.error(JSON.stringify({ level: "error", event: "viptel_listener_fatal", error: message.slice(0, 500) }));
  process.exitCode = 1;
});
