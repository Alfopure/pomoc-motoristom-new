import type { MobileConsole, MobileVoiceReadiness } from "../../../src/lib/mobile-api";
import type { PhoneState } from "./phone";

type Tone = "success" | "warning" | "muted";
type Check = { key: string; label: string; value: string; tone: Tone };
export function phoneReadiness({ state, configuration, configurationError = false, presence, now = Date.now() }: {
  state: PhoneState; configuration?: MobileVoiceReadiness; configurationError?: boolean;
  presence?: MobileConsole["presence"]["status"]; now?: number;
}) {
  const fresh = (date: string | null | undefined, age: number) => {
    const time = date ? Date.parse(date) : NaN;
    return Number.isFinite(time) && now - time >= -30_000 && now - time <= age;
  };
  const configured = !configurationError && fresh(configuration?.checkedAt, 90_000);
  const heartbeat = !state.heartbeatError && fresh(state.lastHeartbeatAt, 60_000);
  const registered = state.supported && state.registration === "registered";
  const background = configured && configuration?.backgroundIncomingEnabled === true && registered && state.pushRegistered === true && heartbeat
    && state.microphonePermission === "granted" && !state.diagnosticsError;
  const microphone = { granted: "Povolený", denied: "Zablokovaný", undetermined: "Čaká na povolenie", unknown: "Neoverený" }[state.microphonePermission];
  const checks: Check[] = [
    { key: "microphone", label: "Mikrofón", value: state.supported ? microphone : "Vyžaduje natívnu aplikáciu", tone: state.supported && state.microphonePermission === "granted" ? "success" : "warning" },
    { key: "connection", label: "Spojenie s ústredňou", value: !registered ? state.registration === "connecting" ? "Pripájam…" : "Nepripojené" : heartbeat ? "Potvrdené" : "Čaká na overenie", tone: registered && heartbeat ? "success" : "warning" },
    { key: "background", label: "Príjem pri zamknutí", value: !configured ? "Nastavenie neoverené" : !configuration?.backgroundIncomingEnabled ? "Zatiaľ neaktivované" : background ? "Registrácia potvrdená" : "Čaká na registráciu", tone: background ? "success" : "warning" },
  ];
  const busy = Boolean(state.call || state.termination || state.dialing || state.cancelingAttempt);
  const canConnect = state.supported && configured && configuration?.nativeCallingEnabled === true && !busy
    && state.registration !== "connecting" && state.registration !== "registered" && state.microphonePermission !== "denied";
  let title = "Telefón je pripojený", tone: Tone = "success";
  let message = "Príjem pri zamknutí overte skúšobným hovorom. Registrácia sama nepotvrdzuje doručenie hovoru.";
  if (!state.supported) {
    title = "Systémové volanie nie je dostupné"; tone = "muted";
    message = "Telefonovanie potrebuje natívnu iPhone aplikáciu. V tejto zostave môžete používať ústredňu, históriu a prípady.";
  } else if (state.termination) {
    title = "Ukončujem hovor…"; tone = "warning"; message = "Čakáme na potvrdenie ústredne. Nový hovor bude dostupný po ukončení.";
  } else if (state.call) {
    const recovering = ["DROPPED", "RECONNECTING"].includes(state.call.state);
    const holdPending = state.nativeSyncPending || state.holdPhase !== "idle" || state.call.media?.state === "pending";
    title = recovering ? "Obnovujem spojenie…" : holdPending ? "Overujem stav podržania…" : state.call.media?.state === "held" ? "Hovor je podržaný" : state.call.connected ? "Prebieha hovor" : "Pripájam hovor…";
    tone = recovering || holdPending ? "warning" : "muted"; message = "Ovládanie aktuálneho hovoru je nad obsahom obrazovky.";
  } else if (state.cancelingAttempt) {
    title = "Ukončujem pôvodný pokus…"; tone = "warning"; message = "Čakáme na overenie a ukončenie pôvodného volania.";
  } else if (state.dialing) {
    title = "Vytáčam…"; tone = "muted"; message = "Ústredňa pripravuje hovor.";
  } else if (state.retryTarget) {
    title = "Posledné volanie nebolo potvrdené"; tone = "warning";
    message = state.takeoverRequired ? "Najprv overte posledný hovor na druhom zariadení. Potom skúste znova pripojiť telefón."
      : "Zopakujte pôvodný pokus o volanie. Nový hovor bude dostupný po jeho vyriešení.";
  } else if (!configured) {
    title = "Nastavenie volania nie je overené"; tone = "warning"; message = "Obnovte stav. Existujúci hovor sa tým nepreruší.";
  } else if (!configuration?.nativeCallingEnabled) {
    title = "Telefonovanie zatiaľ nie je aktivované"; tone = "warning"; message = "Mobilné hovory v tejto TEST aplikácii ešte čakajú na aktiváciu.";
  } else if (state.microphonePermission === "denied") {
    title = "Povoľte mikrofón"; tone = "warning"; message = "V nastaveniach iPhone povoľte tejto aplikácii mikrofón a potom obnovte stav.";
  } else if (state.takeoverRequired) {
    title = "Telefón používa iné zariadenie"; tone = "warning"; message = "Telefón môžete vedome prevziať na tomto iPhone. Druhý mobil sa odpojí.";
  } else if (!registered) {
    title = state.registration === "connecting" ? "Pripájam telefón…" : "Telefón nie je pripojený";
    tone = "warning"; message = "Pripojte telefón, aby ste mohli volať a prijímať hovory v aplikácii.";
  } else if (state.microphonePermission !== "granted" || state.diagnosticsError) {
    title = "Stav mikrofónu nie je overený"; tone = "warning"; message = "Obnovte stav telefónu pred skúšobným hovorom.";
  } else if (!heartbeat) {
    title = "Spojenie s ústredňou nie je potvrdené"; tone = "warning"; message = "Skontrolujte internetové pripojenie a obnovte stav.";
  } else if (presence !== "available") {
    title = "Telefón pripojený, príjem je pozastavený"; tone = "warning"; message = "Pre zákaznícke hovory nastavte stav Dostupný. Vytáčanie zostáva dostupné.";
  }
  return { title, tone, message, checks, canConnect, canTakeover: canConnect && state.takeoverRequired && !state.retryTarget };
}
