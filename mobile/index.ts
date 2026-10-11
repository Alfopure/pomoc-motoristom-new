import { registerRootComponent } from "expo";
import App from "./App";
import { probeNativeVoiceBindings } from "./src/voice/probe";

// The proof profile deliberately fails at boot if native SDK imports are
// incompatible. The normal app and Expo Go never execute this probe.
if (process.env.EXPO_PUBLIC_VOICE_PROOF === "1") {
  probeNativeVoiceBindings();
  console.info("Linka pomoci: native voice import proof passed");
}

registerRootComponent(App);
