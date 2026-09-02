#!/usr/bin/env node

import { createHash } from "node:crypto";

const config = {
  websocketUrl: env("VIPTEL_WEBSOCKET_URL") ?? "wss://pbxwssv1.viptel.sk:8088/",
  username: requiredEnv("VIPTEL_USERNAME"),
  password: requiredEnv("VIPTEL_PASSWORD"),
  listenMs: numberEnv("VIPTEL_LISTEN_MS", 30000),
};

if (typeof WebSocket === "undefined") {
  throw new Error("This Node runtime does not expose a global WebSocket client.");
}

let nonce = null;
let loggedIn = false;
let eventCount = 0;
const startedAt = Date.now();
const ws = new WebSocket(config.websocketUrl);

const timeout =
  config.listenMs > 0
    ? setTimeout(() => {
        console.log(JSON.stringify({ type: "summary", loggedIn, eventCount, elapsedMs: Date.now() - startedAt }));
        ws.close();
      }, config.listenMs)
    : null;

ws.addEventListener("open", () => {
  console.log(JSON.stringify({ type: "connect", url: config.websocketUrl, at: new Date().toISOString() }));
});

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
    console.log(JSON.stringify({ type: "nonce", received: true }));
    return;
  }

  if (!loggedIn && body && typeof body === "object" && "code" in body) {
    loggedIn = body.code === 202 || body.code === "202";
    console.log(JSON.stringify({ type: "login", ok: loggedIn, code: body.code, message: body.message ?? null }));
    return;
  }

  eventCount += 1;
  console.log(JSON.stringify({ type: "event", at: new Date().toISOString(), payload: body }));
});

ws.addEventListener("error", () => {
  console.log(JSON.stringify({ type: "error", message: "websocket error" }));
});

ws.addEventListener("close", () => {
  if (timeout) {
    clearTimeout(timeout);
  }

  console.log(JSON.stringify({ type: "close", loggedIn, eventCount, elapsedMs: Date.now() - startedAt }));
});

function loginHash(username, password, nonceValue) {
  const first = sha1(`${username}:${password}`);
  return sha1(`${first}:${nonceValue}`);
}

function sha1(value) {
  return createHash("sha1").update(value, "utf8").digest("hex");
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

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}
