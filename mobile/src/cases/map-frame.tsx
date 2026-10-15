import { useEffect, useRef, useState } from "react";
import { Alert, Linking, Modal, Platform, ScrollView, Text, UIManager, View } from "react-native";
import { randomUUID } from "expo-crypto";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { WebView as WebViewInstance, WebViewProps } from "react-native-webview";
import type { ComponentType, RefAttributes, ReactNode } from "react";
import type { MobileCasePlaceSelection } from "../../../src/lib/mobile-api";
import type { CasesApi } from "./api";
import { MapBridge, allowsMapNavigation, mapOriginWhitelist, type MapRequest, type MapSeed, type MapSource } from "./map-bridge";
import { confirmAttribution } from "./map-links";
import { Button, Card, ErrorNotice, Loading, styles } from "../ui";

/** Mounted only while this case screen is visible. Credentials never enter the bridge seed. */
export function CaseMapFrame({ api, caseId, mode, target, seed, controls, onClose, onApply }: {
  api: CasesApi; caseId: string | null; mode: MapRequest["mode"]; target: MapRequest["target"]; seed: MapSeed;
  controls?: ReactNode; onClose: () => void; onApply?: (selection: MobileCasePlaceSelection) => void;
}) {
  const insets = useSafeAreaInsets();
  const initial = useRef({ mode, target, caseId, nonce: randomUUID(), seed });
  const webview = useRef<WebViewInstance>(null);
  const bridge = useRef<MapBridge | null>(null);
  const watchdog = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [frame, setFrame] = useState<{ component: ComponentType<WebViewProps & RefAttributes<WebViewInstance>>; source: MapSource } | null>(null);
  const [error, setError] = useState<string | null>(null), [candidate, setCandidate] = useState<MobileCasePlaceSelection | null>(null);
  useEffect(() => {
    if (Platform.OS === "web") return;
    const abort = new AbortController(); let current: MapBridge | null = null;
    watchdog.current = setTimeout(() => {
      if (!abort.signal.aborted) { abort.abort(); current?.close(); setError("Mapa nereaguje. Zatvorte ju a skúste znova."); }
    }, 20_000);
    const { seed: localSeed, ...request } = initial.current;
    void Promise.all([api.mapSource(request, abort.signal), (async () => { if (!UIManager.hasViewManagerConfig("RNCWebView")) throw new Error("Native map frame unavailable"); return import("react-native-webview"); })()]).then(([source, module]) => {
      if (abort.signal.aborted) return;
      current = new MapBridge(source, localSeed); bridge.current = current; setFrame({ component: module.WebView, source });
    }).catch(() => { if (!abort.signal.aborted) setError("Mapu sa nepodarilo otvoriť. Zatvorte ju a skúste znova; adresu môžete zadať ručne."); });
    return () => { abort.abort(); current?.close(); bridge.current = null; if (watchdog.current) clearTimeout(watchdog.current); };
  }, [api]);
  const close = () => { bridge.current?.close(); onClose(); };
  const failed = () => { bridge.current?.close(); setCandidate(null); setError("Mapa nie je dostupná. Zatvorte ju a skúste znova; ručné zadanie adresy zostáva dostupné."); };
  const attribution = (url: string) => {
    const current = bridge.current;
    confirmAttribution(url, {
      current: () => !!current && bridge.current === current && current.isOpen(),
      confirm: proceed => Alert.alert("Otvoriť Google Maps", "Odkaz otvoríte mimo aplikácie. Rozpracované miesto zostane zachované.", [
        { text: "Zostať", style: "cancel" }, { text: "Otvoriť odkaz", onPress: proceed },
      ]),
      open: url => Linking.openURL(url), failed: () => setError("Odkaz sa nepodarilo otvoriť."),
    });
  };
  const WebView = frame?.component;
  return <Modal visible animationType="slide" onRequestClose={close}>
    <ScrollView style={{ flex: 1 }} keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.content, { paddingTop: Math.max(24, insets.top), paddingBottom: Math.max(24, insets.bottom) }]}>
      <Button label="Zatvoriť mapu" onPress={close} secondary />
      <Text style={styles.heading}>{mode === "view" ? "Mapa prípadu" : target === "pickup" ? "Vybrať vyzdvihnutie" : "Vybrať cieľ"}</Text>
      {controls}
      {Platform.OS === "web" ? <ErrorNotice message="Mapa je dostupná v mobilnej aplikácii. Tu môžete adresu zadať ručne alebo použiť navigáciu." />
        : error ? <ErrorNotice message={error} /> : !frame || !WebView ? <Loading /> : <WebView ref={webview}
          source={{ uri: frame.source.uri, headers: frame.source.headers }} style={{ height: 320, flex: 0 }} containerStyle={{ height: 320, flex: 0 }}
          originWhitelist={mapOriginWhitelist} onShouldStartLoadWithRequest={request => {
            const allowed = allowsMapNavigation(request.url, frame.source.uri);
            if (!allowed && request.navigationType === "click") attribution(request.url);
            return allowed;
          }}
          onOpenWindow={event => attribution(event.nativeEvent.targetUrl)} sharedCookiesEnabled={false} thirdPartyCookiesEnabled={false} incognito cacheEnabled={false}
          javaScriptEnabled domStorageEnabled setSupportMultipleWindows allowsInlineMediaPlayback={false} geolocationEnabled={false}
          allowFileAccess={false} allowUniversalAccessFromFileURLs={false} mixedContentMode="never"
          onError={failed} onHttpError={failed} onContentProcessDidTerminate={failed} onRenderProcessGone={failed}
          onMessage={event => {
            const result = bridge.current?.receive(event.nativeEvent.url, event.nativeEvent.data);
            if (result?.seed) { if (watchdog.current) clearTimeout(watchdog.current); webview.current?.postMessage(result.seed); }
            if (result?.selection) setCandidate(result.selection);
            if (result?.error) { bridge.current?.close(); setCandidate(null); setError(result.error); }
          }} />}
      {frame && !error && <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Button label="Podmienky Google" secondary onPress={() => attribution("https://www.google.com/intl/sk/help/terms_maps.html")} />
        <Button label="Súkromie Google" secondary onPress={() => attribution("https://policies.google.com/privacy")} />
      </View>}
      {candidate && !error && <Card><Text style={styles.subheading}>Potvrdiť miesto do formulára</Text>
        <Text selectable style={styles.text}>{candidate.address}</Text><Text style={styles.muted}>{candidate.lat}, {candidate.lng}</Text>
        <Text style={styles.muted}>Prípad sa uloží až tlačidlom Uložiť vo formulári.</Text>
        <Button label="Použiť toto miesto" onPress={() => { if (bridge.current) { bridge.current.close(); onApply?.(candidate); onClose(); } }} />
      </Card>}
    </ScrollView>
  </Modal>;
}
