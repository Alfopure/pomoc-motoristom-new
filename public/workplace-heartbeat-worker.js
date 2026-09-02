let heartbeatTimer = null;

function stopHeartbeat() {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function startHeartbeat(intervalMs) {
  stopHeartbeat();
  const safeIntervalMs = Math.max(5000, Number(intervalMs) || 15000);
  self.postMessage({ kind: "pulse" });
  heartbeatTimer = setInterval(() => {
    self.postMessage({ kind: "pulse" });
  }, safeIntervalMs);
}

self.onmessage = (event) => {
  if (event.data?.kind === "start") {
    startHeartbeat(event.data.intervalMs);
    return;
  }
  if (event.data?.kind === "stop") stopHeartbeat();
};
