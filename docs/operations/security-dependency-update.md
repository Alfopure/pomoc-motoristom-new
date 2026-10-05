# Bezpečnostná aktualizácia závislostí — 2026-10-05

Balík C nadväzuje na opravu prihlásenia a callbacku z PR #374. Aktualizuje oba Next.js projekty v tomto workspace; nemení aplikačnú autorizáciu, telefonické smerovanie, databázu, provider konfiguráciu ani telefónne SDK.

## Rozsah

- Next.js a `eslint-config-next`: 16.2.6 → **16.3.8**. Súvisiace Next/SWC balíky sa aktualizujú spolu; React zostáva 19.2.4.
- Vitest: 4.1.8 → **4.1.11**, bez prechodu na novú hlavnú verziu.
- Opravené kompatibilné závislosti zahŕňajú sharp 0.35.5, postcss 8.5.23/8.5.28, undici 6.29.0/7.30.0, js-yaml 4.3.2, nanoid 3.3.19, Babel 7.29.x, browserslist 4.28.7 a brace-expansion 1.1.21/5.0.12.
- Dva rozsahom obmedzené `pnpm` overrides držia staré browserslist a brace-expansion 5 na opravených vydaniach v rovnakej hlavnej verzii. Ostatné aktualizácie vychádzajú z povolených rozsahov rodičovských balíkov.
- Next 16.3 pridáva vlastné typy `import.meta.glob`. CSRF test preto používa lokálne spresnenie typu mapy modulov namiesto kolidujúcej globálnej deklarácie. Počet a význam testovaných endpointov zostáva rovnaký.

Aktuálna [bezpečnostná informácia Next.js](https://github.com/vercel/next.js/security/advisories/GHSA-vcvr-r3jv-pc5j) uvádza opravu Node ImageResponse od 16.3.6. V pôvodnom audite sa nenašiel útočníkom riadený vstup do našich ikon; samotná zraniteľná verzia preto nebola dôkazom dosiahnuteľného RCE.

## Výsledok skenera a zostávajúce nálezy

Na rovnakom workspace klesol `pnpm audit --json` z **54 hlásení (3 critical, 28 high, 19 moderate, 4 low)** na **2 hlásenia (1 high, 1 moderate)**. Počty pochádzajú z auditu závislostí, nie z počtu preukázaných útokov proti aplikácii. Samostatný `pnpm audit --prod --json` ponecháva iba jeden moderate nález UUID. Žiadne advisory nie je ignorované konfiguráciou.

| Balík | Stav a rozhodnutie |
| --- | --- |
| `braces` 3.0.3, GHSA-vfj7-8cjw-p6xm, high | Je iba vo vývojovej vetve `eslint-config-next → @next/eslint-plugin-next → fast-glob → micromatch`. [Upstream issue](https://github.com/micromatch/braces/issues/70) opisuje vyčerpanie zásobníka hlboko vnoreným glob vzorom. K 5. 10. 2026 register nemá vydanie 3.0.4, hoci npm audit uvádza rozsah `>=3.0.4`; verejný advisory uvádza „None“. Náš ESLint dostáva projektové vzory, nie vstupy návštevníkov aplikácie. Nález zostáva otvorený do kompatibilnej upstream opravy; nie je dôvod meniť telefonický runtime kvôli tomuto vývojovému balíku. |
| `uuid` 7.0.3/8.3.2, GHSA-w5hq-g745-h8pq, moderate | Patrí pod `@telnyx/webrtc` a `@peermetrics/webrtc-stats`. [Advisory](https://github.com/uuidjs/uuid/security/advisories/GHSA-w5hq-g745-h8pq) sa týka metód v3/v5/v6 s odovzdaným výstupným bufferom. Dosiahnuteľnosť tejto podmienky z našej telefonickej cesty nebola preukázaná. Nález zostáva otvorený; nenahrádzame podporované závislosti SDK neovereným skokom na UUID 11. Telnyx SDK zostáva presne **2.27.10**, jeho štatistická knižnica 5.9.0. Oprava vyžaduje kompatibilné upstream vydanie alebo osobitne overený zásah do SDK. |

## Overenie

- Celá aplikácia po aktualizácii podkladu na `dev` commit `811b942`: 6 014 Vitest testov prešlo, 2 boli preskočené; 59 Node testov prešlo, 1 bol preskočený. Zahŕňa aj súbežne vydanú opravu kritickej cesty nahrávania z PR #389.
- Po úprave typov `glob` opakovane prešlo 317 testov auth/CSRF hraníc a cielený ESLint. Typová kontrola prešla.
- Produkčné zostavenie hlavnej aplikácie prešlo. Spustený build vrátil HTTP 200 pre úvodnú stránku, manifest a liveness; `/icon`, `/apple-icon` a `/icon-192` vrátili platné PNG s očakávanými rozmermi.
- Samostatná aplikácia `apps/testovanie`: 17 testov, typová kontrola a build prešli.
- Prešlo 13 izolovaných browserových scenárov obnovy telefónu, pozadia, pauzy a keepalive vrátane reálneho nainštalovaného SDK so syntetickým socketom. Nejde o živé Telnyx hovory.
- Pred merge musí prejsť existujúci Vercel build gate. Na stabilnom TESTE overiť konkrétny commit/deployment, health, prihlásenie, callback, ikony a telefonické správanie po aktualizácii. Hlasová skúška pred aktualizáciou nenahrádza skúšku po nej.

Živé testovanie koordinovať s operátorom. Počas dohodnutej hlasovej skúšky neprepínať TEST na inú verziu. Produkčný release vyžaduje výslovné schválenie identifikovaného rozsahu podľa AGENTS.md; existujúce ďalšie zmeny na `dev` sa k nemu automaticky nepridávajú.
