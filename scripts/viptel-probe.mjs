#!/usr/bin/env node

import { createHash } from "node:crypto";

const args = new Set(process.argv.slice(2));
const outputJson = args.has("--json");
const skipRest = args.has("--no-rest");
const skipWebSocket = args.has("--no-ws");

const config = {
  restBaseUrl: withTrailingSlash(env("VIPTEL_REST_BASE_URL") ?? "https://pbxmanager.viptel.sk/"),
  websocketUrls: websocketUrls(),
  username: requiredEnv("VIPTEL_USERNAME"),
  password: requiredEnv("VIPTEL_PASSWORD"),
  extension: env("VIPTEL_DEFAULT_EXTENSION") ?? "10",
  callerId: env("VIPTEL_CALLER_ID") ?? "0412289133",
};

const result = {
  checkedAt: new Date().toISOString(),
  rest: null,
  websockets: [],
};

if (!skipRest) {
  result.rest = await probeRest();
}

if (!skipWebSocket) {
  for (const url of config.websocketUrls) {
    result.websockets.push(await probeWebSocket(url));
  }
}

if (outputJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  printHuman(result);
}

async function probeRest() {
  const [extensions, outbounds] = await Promise.all([restJson("/api/extension"), restJson("/api/extension/outbounds")]);
  const extensionItems = Array.isArray(extensions.body) ? extensions.body : [];
  const outboundCallerIds = extractOutboundCallerIds(outbounds.body);
  const extension = extensionItems.find((item) => String(item?.extension ?? "") === config.extension) ?? null;

  return {
    baseUrl: config.restBaseUrl,
    extensionStatus: extensions.status,
    outboundsStatus: outbounds.status,
    extensionCount: extensionItems.length,
    extensionFound: Boolean(extension),
    extension: extension
      ? {
          extension: String(extension.extension ?? ""),
          name: stringOrNull(extension.name),
          outboundCid: stringOrNull(extension.outboundcid),
          isRegistered: booleanOrNull(extension.is_registered),
          isViptelPhoneActive: booleanOrNull(extension.is_viptel_phone_active),
        }
      : null,
    outboundCallerIdCount: outboundCallerIds.length,
    callerIdAllowed: outboundCallerIds.some((item) => sameDialNumber(item, config.callerId)),
  };
}

async function restJson(path) {
  const url = new URL(path.replace(/^\//, ""), config.restBaseUrl);
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`, "utf8").toString("base64")}`,
    },
  });
  const text = await response.text();

  return {
    status: response.status,
    body: parseJson(text),
  };
}

async function probeWebSocket(url) {
  if (typeof WebSocket === "undefined") {
    return {
      url,
      ok: false,
      error: "This Node runtime does not expose a global WebSocket client.",
    };
  }

  return new Promise((resolve) => {
    const startedAt = Date.now();
    let nonce = null;
    let settled = false;
    const ws = new WebSocket(url);
    const timeout = setTimeout(() => settle({ ok: false, error: "timeout" }), 12000);

    function settle(payload) {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);

      try {
        ws.close();
      } catch {
        // Best-effort cleanup only.
      }

      resolve({
        url,
        nonceReceived: Boolean(nonce),
        elapsedMs: Date.now() - startedAt,
        ...payload,
      });
    }

    ws.addEventListener("message", (event) => {
      const body = parseJson(String(event.data));

      if (!nonce && body && typeof body === "object" && "nonce" in body) {
        nonce = String(body.nonce);
        ws.send(
          JSON.stringify({
            action: "user.login",
            username: config.username,
            password: loginHash(config.username, config.password, nonce),
          }),
        );
        return;
      }

      const code = body && typeof body === "object" && "code" in body ? body.code : null;
      const message = body && typeof body === "object" && "message" in body ? String(body.message) : null;
      settle({
        ok: code === 202 || code === "202",
        responseCode: code,
        responseMessage: message,
        responseKeys: body && typeof body === "object" ? Object.keys(body).slice(0, 12) : [],
      });
    });

    ws.addEventListener("error", () => {
      settle({ ok: false, error: "websocket error" });
    });

    ws.addEventListener("close", () => {
      settle({ ok: false, error: "closed before login response" });
    });
  });
}

function loginHash(username, password, nonce) {
  const first = sha1(`${username}:${password}`);
  return sha1(`${first}:${nonce}`);
}

function sha1(value) {
  return createHash("sha1").update(value, "utf8").digest("hex");
}

function websocketUrls() {
  const values = (env("VIPTEL_WEBSOCKET_URLS") ?? env("VIPTEL_WEBSOCKET_URL") ?? "wss://pbxwssv1.viptel.sk:8088/")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(values)];
}

function extractOutboundCallerIds(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((item) => {
    if (typeof item === "string" || typeof item === "number") {
      return [String(item)];
    }

    if (!item || typeof item !== "object") {
      return [];
    }

    return [item.outboundcid, item.number, item.caller_id, item.phone_number, item.value].flatMap((candidate) =>
      candidate === undefined || candidate === null ? [] : [String(candidate)],
    );
  });
}

function printHuman(payload) {
  if (payload.rest) {
    console.log(`REST ${payload.rest.baseUrl}`);
    console.log(`  /api/extension: ${payload.rest.extensionStatus}, count=${payload.rest.extensionCount}, ext ${config.extension}=${payload.rest.extensionFound ? "found" : "missing"}`);
    console.log(`  /api/extension/outbounds: ${payload.rest.outboundsStatus}, caller ${config.callerId}=${payload.rest.callerIdAllowed ? "allowed" : "not listed"}`);
  }

  for (const websocket of payload.websockets) {
    console.log(`WS ${websocket.url}`);
    console.log(`  nonce=${websocket.nonceReceived ? "yes" : "no"}, login=${websocket.ok ? "ok" : "failed"}, code=${websocket.responseCode ?? "-"}, message=${websocket.responseMessage ?? websocket.error ?? "-"}`);
  }
}

function parseJson(text) {
  if (!text.trim()) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function requiredEnv(name) {
  const value = env(name);

  if (!value) {
    throw new Error(`${name} is required.`);
  }

  return value;
}

function env(name) {
  const value = process.env[name]?.trim();
  return value && !value.startsWith("replace-with") ? value : undefined;
}

function withTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function sameDialNumber(left, right) {
  return normalizeSlovakDialNumber(left) === normalizeSlovakDialNumber(right);
}

function normalizeSlovakDialNumber(value) {
  const digits = String(value).replace(/\D/g, "");

  if (digits.startsWith("00")) {
    return digits.slice(2);
  }

  if (digits.startsWith("0")) {
    return `421${digits.slice(1)}`;
  }

  return digits;
}

function stringOrNull(value) {
  return typeof value === "string" ? value : null;
}

function booleanOrNull(value) {
  return typeof value === "boolean" ? value : null;
}
