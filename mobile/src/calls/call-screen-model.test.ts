import { describe, expect, it } from "vitest";
import type { DispatchPhone, PhoneState } from "../voice/phone";
import { dialBlockedReason } from "../voice/dial";
import { callView, recordingLabel, recordingView } from "./call-screen-model";

type Call = NonNullable<PhoneState["call"]>;
const base = { nativeSyncPending: false, holdPhase: "idle", supported: true, registration: "registered", takeoverRequired: false, call: null, termination: null,
  dialing: false, cancelingAttempt: false, audioActive: false, muted: false, speaker: false, error: null, microphonePermission: "granted", retryTarget: null } as unknown as PhoneState;
const state = (patch: Partial<PhoneState> = {}) => ({ ...base, ...patch }) as PhoneState;
const call = (patch: Partial<Call> = {}): Call => ({ id: "c", sessionId: "s", number: "+421905111222", displayName: null, state: "ACTIVE", outgoing: false, connected: true,
  media: { state: "active", canHold: true }, ...patch }) as Call;

describe("call screen", () => {
  it("shows nothing without a call", () => {
    expect(callView(state())).toBeNull();
  });
  it("offers answer and decline for a ringing incoming call", () => {
    expect(callView(state({ call: call({ state: "RINGING", connected: false }) }))).toMatchObject({ status: "Prichádzajúci hovor", tone: "ringing", showAnswer: true, showControls: false, endLabel: "Odmietnuť", title: "+421 905 111 222" });
  });
  it("shows the controls of a connected call", () => {
    expect(callView(state({ call: call({ displayName: "Ján" }) }))).toMatchObject({ title: "Ján", status: "Prebieha hovor", tone: "active", showAnswer: false, showControls: true, canHold: true, canKeypad: true, endLabel: "Ukončiť" });
  });
  it("names an outgoing call that is still connecting", () => {
    expect(callView(state({ call: call({ outgoing: true, connected: false, state: "CONNECTING" }) }))).toMatchObject({ status: "Spájam hovor…", showControls: false, endLabel: "Ukončiť" });
  });
  it("keeps a held call resumable and the keypad closed", () => {
    expect(callView(state({ call: call({ media: { state: "held", canHold: true } as Call["media"] }) }))).toMatchObject({ status: "Hovor je podržaný", tone: "held", held: true, canHold: true, canKeypad: false });
  });
  it("waits for a pending hold and reports an uncertain one", () => {
    expect(callView(state({ call: call(), holdPhase: "uncertain" } as Partial<PhoneState>))).toMatchObject({ status: "Overujem stav podržania…", holdPending: true, holdUncertain: true, canKeypad: false });
  });
  it("hides the controls while reconnecting and repeats a pending hang-up", () => {
    expect(callView(state({ call: call({ state: "RECONNECTING" }) }))).toMatchObject({ status: "Obnovujem spojenie…", showControls: false });
    expect(callView(state({ call: null, termination: "s" } as Partial<PhoneState>))).toMatchObject({ status: "Ukončujem hovor…", endLabel: "Zopakovať ukončenie", showControls: false, title: "Hovor" });
  });
  it("starts a new call only from a ready phone", () => {
    const phone = {} as DispatchPhone;
    expect(dialBlockedReason(null, state())).toMatch(/natívnej aplikácii/);
    expect(dialBlockedReason(phone, state({ registration: "connecting" } as Partial<PhoneState>))).toMatch(/nie je pripojený/);
    expect(dialBlockedReason(phone, state({ microphonePermission: "denied" } as Partial<PhoneState>))).toMatch(/mikrofónu/);
    expect(dialBlockedReason(phone, state({ call: call() }))).toMatch(/Počas hovoru/);
    expect(dialBlockedReason(phone, state({ dialing: true }))).toMatch(/vytáča/);
    expect(dialBlockedReason(phone, state())).toBeNull();
  });
});

describe("transfer and recording on the call screen", () => {
  it("offers transfer only for a settled connected call", () => {
    expect(callView(state({ call: call() }))?.canTransfer).toBe(true);
    expect(callView(state({ call: call({ state: "RINGING", connected: false }) }))?.canTransfer).toBe(false);
    expect(callView(state({ call: call(), holdPhase: "pending" } as Partial<PhoneState>))?.canTransfer).toBe(false);
    expect(callView(state({ call: call(), termination: "s" }))?.canTransfer).toBe(false);
    expect(callView(state({ call: call({ internal: true }) }))?.canTransfer).toBe(false);
  });
  it("names the recorder for announcements", () => {
    expect(recordingLabel({ state: "stopping", suppressed: true })).toBe("Zastavenie čaká na potvrdenie");
    expect(recordingLabel({ state: "stopped", suppressed: true })).toBe("Nahrávanie zastavené, už sa neobnoví");
    expect(recordingLabel({ state: "off", suppressed: false })).toBeNull(); expect(recordingLabel(null)).toBeNull();
  });
  it("shows the recorder and the stop only while recording can still be stopped", () => {
    const view = (recording: Call["recording"], patch: Partial<Call> = {}) => { const value = state({ call: call({ recording, ...patch }) }); return recordingView(value, callView(value)); };
    expect(view(null)).toBeNull();
    expect(view({ state: "off", suppressed: false })).toBeNull();
    expect(view({ state: "recording", suppressed: false })).toMatchObject({ label: "Nahráva sa", tone: "red", canStop: true, retry: false });
    expect(view({ state: "notice", suppressed: false })).toMatchObject({ canStop: true });
    expect(view({ state: "stopping", suppressed: true })).toMatchObject({ canStop: false, unconfirmed: true });
    expect(view({ state: "stopped", suppressed: true })).toMatchObject({ label: "Nahrávanie zastavené, už sa neobnoví", tone: "gray", canStop: false });
    expect(view({ state: "unknown", suppressed: false })).toMatchObject({ canStop: true, retry: true });
    expect(view({ state: "recording", suppressed: false }, { connected: false })).toBeNull();
    expect(view({ state: "recording", suppressed: false }, { state: "RECONNECTING" })).toMatchObject({ canStop: false });
  });
});
