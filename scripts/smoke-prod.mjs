const DEFAULT_BASE_URL = "https://dispecing.linkapomoci.sk";
const DEFAULT_WEBDISPECINK_SYNC_PATH = "/api/integrations/fleet/webdispecink/sync";
const DEFAULT_TIMEOUT_MS = 15000;

const baseUrl = process.env.SMOKE_PROD_BASE_URL ?? DEFAULT_BASE_URL;
const webdispecinkSyncPath =
  process.env.SMOKE_PROD_WEBDISPECINK_SYNC_PATH ?? DEFAULT_WEBDISPECINK_SYNC_PATH;
const timeoutMs = parsePositiveInt(process.env.SMOKE_PROD_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);

const checks = [
  {
    name: "WebDispecink sync route rejects unauthenticated cron calls",
    url: new URL(webdispecinkSyncPath, ensureTrailingSlash(baseUrl)),
    expectedStatus: 401,
    notFoundMessage:
      "Production does not contain the WebDispecink sync route; check the Vercel deployment branch.",
  },
];

try {
  for (const check of checks) {
    await runStatusCheck(check);
  }

  console.log(`[smoke:prod] OK ${checks.length} production check(s) passed.`);
} catch (error) {
  console.error(`[smoke:prod] FAIL ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

async function runStatusCheck(check) {
  console.log(`[smoke:prod] Checking ${check.url.href}`);

  const response = await fetchWithTimeout(check.url);
  const responseSnippet = await readResponseSnippet(response);

  if (response.status === check.expectedStatus) {
    console.log(`[smoke:prod] OK ${check.name}: HTTP ${response.status}`);
    return;
  }

  if (response.status === 404) {
    throw new Error(`${check.name}: HTTP 404. ${check.notFoundMessage}${formatSnippet(responseSnippet)}`);
  }

  throw new Error(
    `${check.name}: expected HTTP ${check.expectedStatus}, got HTTP ${response.status}.${formatSnippet(
      responseSnippet,
    )}`,
  );
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      method: "GET",
      headers: {
        accept: "application/json, text/plain, */*",
      },
      redirect: "manual",
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`request timed out after ${timeoutMs}ms: ${url.href}`);
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readResponseSnippet(response) {
  const text = await response.text().catch(() => "");

  return text.replace(/\s+/g, " ").trim().slice(0, 400);
}

function formatSnippet(snippet) {
  return snippet ? ` Response snippet: ${snippet}` : "";
}

function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function parsePositiveInt(value, fallback) {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);

  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
