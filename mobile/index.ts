import { registerRootComponent } from "expo";
import App from "./App";
import { defineLocationTasks } from "./src/delivery/native-sharing";
import { probeNativeVoiceBindings } from "./src/voice/probe";

// Before anything else: iOS may start the app in the background only to hand it a
// location of a running delivery or operation.
defineLocationTasks();

// The proof profile deliberately fails at boot if native SDK imports are
// incompatible. The normal app and Expo Go never execute this probe.
if (process.env.EXPO_PUBLIC_VOICE_PROOF === "1") {
  probeNativeVoiceBindings();
  console.info("Linka pomoci: native voice import proof passed");
}

registerRootComponent(App);
