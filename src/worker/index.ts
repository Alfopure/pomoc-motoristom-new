import { ProductionWorker } from "./scheduler";
import { safeErrorMessage } from "./redaction";

const worker = new ProductionWorker();

worker.start().catch((error) => {
  console.error(JSON.stringify({ level: "fatal", event: "worker_crashed", error: safeErrorMessage(error) }));
  process.exitCode = 1;
});
