import type { Instrumentation } from "next";

/** Next owns the hook lifecycle; await bounded reporting without forwarding request data. */
export const onRequestError: Instrumentation.onRequestError = async (error, _request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.DIAGNOSTICS_SERVER_ERRORS_ENABLED !== "true") return;
  try {
    const { captureServerError } = await import("./server/diagnostics/server-errors");
    await captureServerError(error, { source: "next", route: context.routePath, status: 500 });
  } catch { /* The original framework error remains the request's result. */ }
};
