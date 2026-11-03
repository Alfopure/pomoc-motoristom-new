import { useEffect, useState, type PropsWithChildren } from "react";
import { AccessibilityInfo, AppState, Platform, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { requireOptionalNativeModule } from "expo-modules-core";
import type { GlassView } from "expo-glass-effect";
import type { BlurView } from "expo-blur";
import { loadSurface, surfaceKind, type GlassCapabilities, type GlassPreferences } from "./glass-capabilities";
import { colors } from "./theme";

type Renderer = { kind: "glass"; Component: typeof GlassView } | { kind: "blur"; Component: typeof BlurView };
function useGlassPreferences(): GlassPreferences {
  const [preferences, setPreferences] = useState<GlassPreferences>({ reduceTransparency: true, reduceMotion: true });
  useEffect(() => {
    let alive = true;
    const generation = { reduceTransparency: 0, reduceMotion: 0 };
    function changed(key: keyof GlassPreferences, value: boolean) {
      generation[key]++;
      if (alive) setPreferences(previous => ({ ...previous, [key]: value }));
    }
    function read(key: keyof GlassPreferences, get: () => Promise<boolean>) {
      const current = ++generation[key];
      void get().then(value => {
        if (alive && generation[key] === current) setPreferences(previous => ({ ...previous, [key]: value }));
      }).catch(() => {
        if (alive && generation[key] === current) setPreferences(previous => ({ ...previous, [key]: true }));
      });
    }
    function refresh() {
      read("reduceMotion", () => AccessibilityInfo.isReduceMotionEnabled());
      if (Platform.OS === "ios") read("reduceTransparency", () => AccessibilityInfo.isReduceTransparencyEnabled());
    }
    const motion = AccessibilityInfo.addEventListener("reduceMotionChanged", value => changed("reduceMotion", value));
    const transparency = Platform.OS === "ios" ? AccessibilityInfo.addEventListener("reduceTransparencyChanged", value => changed("reduceTransparency", value)) : null;
    const resume = AppState.addEventListener("change", state => { if (state === "active") refresh(); });
    refresh();
    return () => { alive = false; motion.remove(); transparency?.remove(); resume.remove(); };
  }, []);
  return preferences;
}

export function GlassSurface({ children, style, interactive = false }: PropsWithChildren<{ style?: StyleProp<ViewStyle>; interactive?: boolean }>) {
  const preferences = useGlassPreferences();
  const [renderer, setRenderer] = useState<Renderer | null>(null);
  const nativeGlass = Platform.OS === "ios" ? requireOptionalNativeModule<GlassCapabilities>("ExpoGlassEffect") : null;
  const nativeBlur = Platform.OS === "ios" && requireOptionalNativeModule("ExpoBlur") !== null;
  const kind = surfaceKind(Platform.OS, preferences, nativeGlass, nativeBlur);
  useEffect(() => {
    let alive = true;
    void loadSurface<Renderer>(kind, {
      glass: async () => ({ kind: "glass", Component: (await import("expo-glass-effect")).GlassView }),
      blur: async () => ({ kind: "blur", Component: (await import("expo-blur")).BlurView }),
    }).then(value => { if (alive) setRenderer(value); });
    return () => { alive = false; };
  }, [kind]);
  // Preference changes take effect immediately, before an import can finish.
  if (kind === "glass" && renderer?.kind === "glass") return <renderer.Component style={[s.surface, style]} colorScheme="light" glassEffectStyle={{ style: "regular", animate: false }} isInteractive={interactive && !preferences.reduceMotion}>{children}</renderer.Component>;
  if (kind === "blur" && renderer?.kind === "blur") return <renderer.Component style={[s.surface, style]} tint="systemChromeMaterialLight" intensity={85}>{children}</renderer.Component>;
  return <View style={[s.surface, style, s.solid]}>{children}</View>;
}
const s = StyleSheet.create({
  surface: { borderRadius: 30, overflow: "hidden", borderWidth: 1, borderColor: "rgba(255,255,255,0.8)" },
  solid: { backgroundColor: colors.white, borderColor: colors.border },
});
