#!/usr/bin/env node

// Phase 0 probe for the call-recordings plan (.omc/plans/call-recordings-transcription-ai-qa.md).
// Verifies the VIPTel CDR API surface documented in docs/viptel-call-center-plan.md:28-32
// and inspects one real recording (mono/stereo, codec) to decide the diarization strategy.
//
// Usage: set -a; source .env.prod-pull; set +a; node scripts/viptel-cdr-probe.mjs [--json] [--limit N]

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const outputJson = args.includes("--json");
const limit = readArgValue("--limit") ?? "5";

const config = {
  restBaseUrl: withTrailingSlash(env("VIPTEL_REST_BASE_URL") ?? "https://pbxmanager.viptel.sk/"),
  username: requiredEnv("VIPTEL_USERNAME"),
  password: requiredEnv("VIPTEL_PASSWORD"),
};

const result = {
  checkedAt: new Date().toISOString(),
  baseUrl: config.restBaseUrl,
  cdrList: null,
  cdrRecordings: null,
  download: null,
};

result.cdrList = await probeList("/api/cdr/", { limit });
result.cdrRecordings = await probeList("/api/cdr/recordings", { limit });

const downloadCandidate = pickDownloadCandidate(result.cdrRecordings.records ?? []);

if (downloadCandidate) {
  result.download = await probeDownload(downloadCandidate);
} else {
  result.download = { skipped: true, reason: "No CDR with a recording reference found in the sample." };
}

if (outputJson) {
  console.log(JSON.stringify(result, null, 2));
} else {
  printHuman(result);
}

async function probeList(apiPath, query) {
  const url = new URL(apiPath.replace(/^\//, ""), config.restBaseUrl);
  Object.entries(query).forEach(([key, value]) => url.searchParams.set(key, value));

  const response = await fetch(url, { headers: authHeaders({ Accept: "application/json" }) });
  const text = await response.text();
  const body = parseJson(text);
  const records = extractRecords(body);

  return {
    url: url.toString(),
    status: response.status,
    topLevelShape: describeShape(body),
    recordCount: records.length,
    recordKeys: records[0] ? Object.keys(records[0]) : [],
    firstRecord: records[0] ?? null,
    records,
  };
}

async function probeDownload(candidate) {
  const url = new URL(`api/cdr/download/${encodeURIComponent(candidate.id)}`, config.restBaseUrl);
  const response = await fetch(url, { headers: authHeaders({}) });
  const contentType = response.headers.get("content-type");
  const disposition = response.headers.get("content-disposition");

  if (!response.ok) {
    const text = await response.text();
    return { url: url.toString(), status: response.status, error: text.slice(0, 400) };
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const outDir = path.join(process.cwd(), ".context");
  mkdirSync(outDir, { recursive: true });
  const extension = guessExtension(contentType, buffer);
  const outPath = path.join(outDir, `viptel-recording-sample${extension}`);
  writeFileSync(outPath, buffer);

  return {
    url: url.toString(),
    status: response.status,
    usedRecordId: candidate.id,
    usedRecordIdSource: candidate.source,
    contentType,
    contentDisposition: disposition,
    sizeBytes: buffer.length,
    savedTo: outPath,
    audio: analyzeAudio(outPath, buffer),
  };
}

function analyzeAudio(filePath, buffer) {
  const viaFfprobe = tryFfprobe(filePath);

  if (viaFfprobe) {
    return { method: "ffprobe", ...viaFfprobe };
  }

  return { method: "header-parse", ...parseAudioHeader(buffer) };
}

function tryFfprobe(filePath) {
  try {
    const output = execFileSync(
      "ffprobe",
      ["-v", "quiet", "-print_format", "json", "-show_streams", "-show_format", filePath],
      { encoding: "utf8" },
    );
    const parsed = JSON.parse(output);
    const stream = (parsed.streams ?? []).find((item) => item.codec_type === "audio");

    if (!stream) {
      return { error: "ffprobe found no audio stream" };
    }

    return {
      codec: stream.codec_name,
      channels: stream.channels,
      channelLayout: stream.channel_layout,
      sampleRate: stream.sample_rate,
      durationSeconds: Number(parsed.format?.duration ?? stream.duration ?? 0),
      bitRate: parsed.format?.bit_rate,
    };
  } catch {
    return null;
  }
}

function parseAudioHeader(buffer) {
  if (buffer.length >= 44 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WAVE") {
    return {
      container: "wav",
      channels: buffer.readUInt16LE(22),
      sampleRate: buffer.readUInt32LE(24),
      bitsPerSample: buffer.readUInt16LE(34),
    };
  }

  const frameOffset = findMp3FrameSync(buffer);

  if (frameOffset !== -1) {
    const channelModeBits = (buffer[frameOffset + 3] & 0b11000000) >> 6;
    const channelModes = ["stereo", "joint_stereo", "dual_channel", "mono"];
    return { container: "mp3", channelMode: channelModes[channelModeBits], frameOffset };
  }

  return { container: "unknown", firstBytesHex: buffer.subarray(0, 16).toString("hex") };
}

function findMp3FrameSync(buffer) {
  const searchLimit = Math.min(buffer.length - 4, 65536);

  for (let index = 0; index < searchLimit; index += 1) {
    if (buffer[index] === 0xff && (buffer[index + 1] & 0xe0) === 0xe0) {
      return index;
    }
  }

  return -1;
}

function pickDownloadCandidate(records) {
  for (const record of records) {
    for (const key of ["id", "cdr_id", "uniqueid", "unique_id"]) {
      const value = record?.[key];

      if (value !== undefined && value !== null && String(value).trim()) {
        return { id: String(value).trim(), source: key };
      }
    }
  }

  return null;
}

function extractRecords(body) {
  if (Array.isArray(body)) {
    return body.filter((item) => item && typeof item === "object");
  }

  if (body && typeof body === "object") {
    for (const key of ["data", "records", "cdr", "items", "results", "rows"]) {
      if (Array.isArray(body[key])) {
        return body[key].filter((item) => item && typeof item === "object");
      }
    }
  }

  return [];
}

function describeShape(body) {
  if (Array.isArray(body)) {
    return `array(len=${body.length})`;
  }

  if (body && typeof body === "object") {
    return `object(keys=${Object.keys(body).slice(0, 12).join(",")})`;
  }

  return typeof body === "string" ? `string(${body.slice(0, 120)})` : String(body);
}

function authHeaders(extra) {
  return {
    ...extra,
    Authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`, "utf8").toString("base64")}`,
  };
}

function guessExtension(contentType, buffer) {
  if (contentType?.includes("wav") || buffer.toString("ascii", 0, 4) === "RIFF") {
    return ".wav";
  }

  if (contentType?.includes("mpeg") || contentType?.includes("mp3")) {
    return ".mp3";
  }

  if (contentType?.includes("ogg")) {
    return ".ogg";
  }

  return ".bin";
}

function printHuman(payload) {
  for (const [label, list] of [["CDR list", payload.cdrList], ["CDR recordings", payload.cdrRecordings]]) {
    console.log(`${label}: ${list.url}`);
    console.log(`  status=${list.status}, shape=${list.topLevelShape}, records=${list.recordCount}`);
    console.log(`  record keys: ${list.recordKeys.join(", ") || "-"}`);

    if (list.firstRecord) {
      console.log(`  first record: ${JSON.stringify(list.firstRecord)}`);
    }
  }

  const download = payload.download;
  console.log("Download:");

  if (download.skipped) {
    console.log(`  skipped: ${download.reason}`);
    return;
  }

  console.log(`  status=${download.status}${download.error ? `, error=${download.error}` : ""}`);

  if (download.status === 200) {
    console.log(`  id=${download.usedRecordId} (from ${download.usedRecordIdSource})`);
    console.log(`  content-type=${download.contentType}, size=${download.sizeBytes}B, saved=${download.savedTo}`);
    console.log(`  audio: ${JSON.stringify(download.audio)}`);
  }
}

function readArgValue(flag) {
  const index = args.indexOf(flag);
  return index !== -1 && args[index + 1] ? args[index + 1] : undefined;
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
