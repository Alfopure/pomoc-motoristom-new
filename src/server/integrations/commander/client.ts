import "server-only";

export type CommanderEndpoint = "vehicles" | "positions" | "rides";

export type CommanderRateLimit = {
  limit: number | null;
  remaining: number | null;
  reset: string | null;
  retryAfterSeconds: number | null;
};

export type CommanderResponse<T> = {
  endpoint: CommanderEndpoint;
  path: string;
  status: number;
  ok: boolean;
  data: T | null;
  error: string | null;
  rateLimit: CommanderRateLimit;
  headersSafe: Record<string, string>;
};

export type CommanderVehiclePayload = {
  vehicles?: unknown[];
};

export type CommanderPositionPayload = {
  positions?: unknown[];
  page?: number;
  count?: number;
  totalPages?: number;
  totalCount?: number;
};

export type CommanderRidesPayload = {
  rides?: unknown[];
  page?: number;
  count?: number;
  totalPages?: number;
  totalCount?: number;
};

const DEFAULT_COMMANDER_API_BASE_URL = "https://online.commander-systems.com/api/v1";
const DEFAULT_PAGE_LIMIT = 100;
// Commander občas visí bez odpovede; bez timeoutu sa celý sync-beh zablokuje až do platformového limitu.
const REQUEST_TIMEOUT_MS = 20_000;

export class CommanderConfigError extends Error {
  readonly status = 500;
}

export class CommanderClient {
  private readonly baseUrl: string;
  private readonly authorization: string;

  constructor(config = commanderConfigFromEnv()) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    this.authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`;
  }

  async listVehicles() {
    return this.request<CommanderVehiclePayload>("vehicles", "/vehicles");
  }

  async listLastPositions(page = 1, limit = DEFAULT_PAGE_LIMIT) {
    return this.request<CommanderPositionPayload>("positions", `/last-positions?page=${page}&limit=${limit}`);
  }

  async listAllRides(request: { datetimeStart: number; datetimeEnd: number; page?: number; limit?: number }) {
    const page = request.page ?? 1;
    const limit = request.limit ?? DEFAULT_PAGE_LIMIT;
    const params = new URLSearchParams({
      datetimeStart: String(request.datetimeStart),
      datetimeEnd: String(request.datetimeEnd),
      page: String(page),
      limit: String(limit),
    });

    return this.request<CommanderRidesPayload>("rides", `/all-rides?${params.toString()}`);
  }

  private async request<T>(endpoint: CommanderEndpoint, path: string): Promise<CommanderResponse<T>> {
    let response: Response;

    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        headers: {
          Accept: "application/json",
          Authorization: this.authorization,
        },
        cache: "no-store",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      return requestFailure(endpoint, path, error);
    }

    let text: string;
    try {
      text = await response.text();
    } catch (error) {
      return {
        endpoint,
        path,
        status: response.status,
        ok: false,
        data: null,
        error: `Commander API response body could not be read: ${errorMessage(error)}`,
        rateLimit: rateLimitFromHeaders(response.headers),
        headersSafe: safeHeaders(response.headers),
      };
    }

    const data = parseJson<T>(text);

    return {
      endpoint,
      path,
      status: response.status,
      ok: response.ok && data !== null,
      data: response.ok ? data : null,
      error: response.ok ? data === null ? "Commander returned invalid JSON." : null : errorMessageFromPayload(data, text),
      rateLimit: rateLimitFromHeaders(response.headers),
      headersSafe: safeHeaders(response.headers),
    };
  }
}

function commanderConfigFromEnv() {
  const baseUrl = process.env.COMMANDER_API_BASE_URL?.trim() || DEFAULT_COMMANDER_API_BASE_URL;
  const username = process.env.COMMANDER_API_USERNAME?.trim();
  const password = process.env.COMMANDER_API_PASSWORD?.trim();

  if (!username || !password || username.startsWith("replace-with-") || password.startsWith("replace-with-")) {
    throw new CommanderConfigError("Missing Commander API credentials. Set COMMANDER_API_USERNAME and COMMANDER_API_PASSWORD.");
  }

  return { baseUrl, username, password };
}

function parseJson<T>(text: string): T | null {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function errorMessageFromPayload(payload: unknown, fallback: string) {
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const message = record.message ?? record.error;

    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }

  return fallback.slice(0, 500) || "Commander API request failed.";
}

function numberHeader(value: string | null) {
  if (!value) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function resetHeader(value: string | null) {
  const parsed = numberHeader(value);

  if (!parsed) {
    return null;
  }

  return new Date(parsed * 1000).toISOString();
}

function rateLimitFromHeaders(headers: Headers): CommanderRateLimit {
  return {
    limit: numberHeader(headers.get("x-ratelimit-limit")),
    remaining: numberHeader(headers.get("x-ratelimit-remaining")),
    reset: resetHeader(headers.get("x-ratelimit-reset")),
    retryAfterSeconds: numberHeader(headers.get("retry-after")),
  };
}

function requestFailure<T>(endpoint: CommanderEndpoint, path: string, error: unknown): CommanderResponse<T> {
  return {
    endpoint,
    path,
    status: 599,
    ok: false,
    data: null,
    error: `Commander API request failed before receiving a response: ${errorMessage(error)}`,
    rateLimit: {
      limit: null,
      remaining: null,
      reset: null,
      retryAfterSeconds: null,
    },
    headersSafe: {},
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function safeHeaders(headers: Headers) {
  const safe: Record<string, string> = {};
  for (const key of ["x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset", "retry-after"]) {
    const value = headers.get(key);
    if (value) {
      safe[key] = value;
    }
  }
  return safe;
}
