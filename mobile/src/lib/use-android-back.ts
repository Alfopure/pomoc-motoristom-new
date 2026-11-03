import { useEffect } from "react";
import { BackHandler, Platform } from "react-native";

/** Only the current visible screen owns Back. Parents with a visible child
 * must pass active=false, so effect registration order cannot change routing. */
export function useAndroidBack(active: boolean, onBack: () => void, blocked = false): void {
  useEffect(() => {
    if (!active || Platform.OS !== "android") return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      if (!blocked) onBack();
      return true;
    });
    return () => subscription.remove();
  }, [active, onBack, blocked]);
}
