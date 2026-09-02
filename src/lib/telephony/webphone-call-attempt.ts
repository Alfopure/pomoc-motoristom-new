export type BrowserSipFinalResponse =
  | { outcome: "accepted" }
  | { outcome: "rejected"; statusCode?: number }
  | { outcome: "ended_before_answer" };

export type BrowserSipCallAttempt = {
  finalResponse: Promise<BrowserSipFinalResponse>;
};

export type BrowserSipCallAttemptController = {
  attempt: BrowserSipCallAttempt;
  settled: () => boolean;
  settle: (response: BrowserSipFinalResponse) => boolean;
};

export function createBrowserSipCallAttempt(): BrowserSipCallAttemptController {
  let resolveResponse: (response: BrowserSipFinalResponse) => void = () => undefined;
  let isSettled = false;
  const finalResponse = new Promise<BrowserSipFinalResponse>((resolve) => {
    resolveResponse = resolve;
  });

  return {
    attempt: { finalResponse },
    settled: () => isSettled,
    settle: (response) => {
      if (isSettled) return false;
      isSettled = true;
      resolveResponse(response);
      return true;
    },
  };
}

export function safeSipStatusCode(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 300 && value <= 699
    ? value
    : undefined;
}
