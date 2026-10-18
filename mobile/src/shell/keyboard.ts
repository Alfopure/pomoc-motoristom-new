import { useEffect, useState } from "react";
import { Keyboard, Platform } from "react-native";

/** True while the software keyboard covers the bottom; floating bars step aside. */
export function useKeyboardShown(): boolean {
  const [shown, setShown] = useState(() => Platform.OS !== "web" && Keyboard.isVisible());
  useEffect(() => {
    if (Platform.OS === "web") return;
    const didShow = Keyboard.addListener("keyboardDidShow", () => setShown(true));
    const didHide = Keyboard.addListener("keyboardDidHide", () => setShown(false));
    const willShow = Platform.OS === "ios" ? Keyboard.addListener("keyboardWillShow", () => setShown(true)) : null;
    return () => { didShow.remove(); didHide.remove(); willShow?.remove(); };
  }, []);
  return shown;
}
