import { describe, expect, it } from "vitest";

import { extractCdrRecords, normalizeCdrRecord } from "./client";

describe("normalizeCdrRecord", () => {
  it("maps the real VIPTel CDR payload (probe fixture, 2026-07-02)", () => {
    const record = normalizeCdrRecord({
      id: "3",
      type: "incoming",
      when: "2026-05-28 11:06:53",
      caller: "00421910818189",
      caller_name: null,
      received: "0412289133",
      received_name: null,
      destination: "10",
      destination_name: "Miso",
      duration: "36",
      status: "answered",
      application: "queue",
      recording_file: "q-500-00421910818189-20260528-110653-1779959213.4.mp3",
      unique_id: "1779959213.4",
      complete_duration: "36",
    });

    expect(record.cdrId).toBe("3");
    expect(record.viptelUniqueId).toBe("1779959213.4");
    expect(record.direction).toBe("inbound");
    expect(record.startedAt).toBe("2026-05-28T09:06:53.000Z");
    expect(record.callerNumber).toBe("00421910818189");
    expect(record.calledNumber).toBe("0412289133");
    expect(record.receivedNumber).toBe("0412289133");
    expect(record.destinationNumber).toBe("10");
    expect(record.destinationName).toBe("Miso");
    expect(record.application).toBe("queue");
    expect(record.durationSeconds).toBe(36);
    expect(record.completeDurationSeconds).toBe(36);
    expect(record.ringSeconds).toBe(0);
    expect(record.disposition).toBe("answered");
    expect(record.recordingFile).toBe("q-500-00421910818189-20260528-110653-1779959213.4.mp3");
    expect(record.hasRecording).toBe(true);
  });

  it("maps asterisk-style CDR keys", () => {
    const record = normalizeCdrRecord({
      id: 12345,
      uniqueid: "1751370000.42",
      calldate: "2026-07-01 10:15:00",
      src: "0910988882",
      dst: "0412289133",
      duration: 95,
      billsec: 80,
      disposition: "ANSWERED",
      recordingfile: "external-0910988882-20260701.wav",
    });

    expect(record.cdrId).toBe("12345");
    expect(record.viptelUniqueId).toBe("1751370000.42");
    expect(record.callerNumber).toBe("0910988882");
    expect(record.calledNumber).toBe("0412289133");
    expect(record.durationSeconds).toBe(95);
    expect(record.billSeconds).toBe(80);
    expect(record.disposition).toBe("ANSWERED");
    expect(record.hasRecording).toBe(true);
    expect(record.startedAt).toBe("2026-07-01T08:15:00.000Z");
  });

  it("maps snake_case alternative keys and boolean recording flags", () => {
    const record = normalizeCdrRecord({
      cdr_id: "abc",
      unique_id: "u-1",
      start_time: "2026-07-01T08:00:00Z",
      caller_number: "+421910988882",
      called_number: "112",
      duration_seconds: "60",
      has_recording: 1,
    });

    expect(record.cdrId).toBe("abc");
    expect(record.viptelUniqueId).toBe("u-1");
    expect(record.callerNumber).toBe("+421910988882");
    expect(record.durationSeconds).toBe(60);
    expect(record.hasRecording).toBe(true);
    expect(record.recordingFile).toBeUndefined();
    expect(record.startedAt).toBe("2026-07-01T08:00:00.000Z");
  });

  it("uses the winter Bratislava offset for a timezone-less PBX wall clock", () => {
    const record = normalizeCdrRecord({
      id: "winter-call",
      when: "2026-01-15 10:15:00",
    });

    expect(record.startedAt).toBe("2026-01-15T09:15:00.000Z");
  });

  it("reports hasRecording=false without any recording signal", () => {
    const record = normalizeCdrRecord({ id: 1, src: "111" });
    expect(record.hasRecording).toBe(false);
  });
});

describe("extractCdrRecords", () => {
  const row = { id: 7, src: "0910", dst: "0412" };

  it("accepts a bare array", () => {
    expect(extractCdrRecords([row])).toHaveLength(1);
  });

  it.each([["data"], ["cdr"], ["records"], ["items"], ["results"], ["rows"]])("accepts records nested under %s", (key) => {
    expect(extractCdrRecords({ [key]: [row] })).toHaveLength(1);
  });

  it("drops entries without any usable id", () => {
    expect(extractCdrRecords([{ src: "0910" }, row])).toHaveLength(1);
  });

  it("returns [] for unexpected payloads", () => {
    expect(extractCdrRecords(null)).toEqual([]);
    expect(extractCdrRecords("error")).toEqual([]);
    expect(extractCdrRecords({ message: "no data" })).toEqual([]);
  });
});
