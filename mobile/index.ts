import { registerRootComponent } from "expo";
import App from "./App";
import { defineLocationTasks } from "./src/delivery/native-sharing";
import { probeNativeVoiceBindings } from "./src/voice/probe";

// Before anything else: iOS may start the app in the background only to hand it a
// location of a running delivery or operation.
defineLocationTasks();

// The TEST calling build deliberately fails at boot if native SDK imports are
// incompatible or the calling gate is closed. Production keeps running without
// calling and reports the failure after sign-in. Builds without calling and Expo
// Go never execute this probe.
if (process.env.EXPO_PUBLIC_VOICE_PROOF === "1"
  && probeNativeVoiceBindings(process.env.EXPO_PUBLIC_APP_ENV !== "production")) {
  console.info("Linka pomoci: native voice import proof passed");
}

registerRootComponent(App);
