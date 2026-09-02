# Demo Flow

## Primárny scenár

1. Dispečer otvorí dashboard a vidí prichádzajúci hovor na linku `0850 005 006`.
2. Call bar zobrazí volajúce číslo, meno, volanú linku, stav hovoru a históriu čísla.
3. Klik na `Nový prípad` otvorí kartu prípadu `PM-2026-0517`.
4. Dispečer vidí kontakt, vozidlo, pickup, cieľ, poznámku, úlohu a timeline.
5. Google mapa ukáže pickup, cieľ, pobočky, odťahovky, náhradné vozidlá, trasu, km/ETA, najbližší asset a cenový kontext.
6. Dispečer môže v mape použiť Google Places našeptávač pre adresu vyzdvihnutia a cieľ/servis; výber prepočíta náhľad trasy.
7. SMS preview zobrazí lokalizačný link a ETA bez reálneho odoslania.
8. Reporty ukážu denné metriky: hovory, prijaté, zmeškané, nové prípady, otvorené úlohy, marné výjazdy, dovolateľnosť.
9. Integrácie ukážu roadmap panely pre VIPTel, SMS, Supabase, Webdispečink, Commander a AI.

## Map provider

Primárny mapový provider je Google Maps JavaScript API. Places autocomplete používa nový `PlaceAutocompleteElement`, je obmedzený na Slovensko a pýta iba základné polia potrebné pre adresu a geometriu.

Trasa používa server-side Google Routes API pre cestný výpočet asset → pickup → cieľ → pobočka. Ak chýba serverový Google kľúč alebo Routes API zlyhá, demo sa degraduje na existujúci výpočet km/ETA a Leaflet/OSM fallback, aby zostali viditeľné markery, trasa, kontext najbližšej kapacity a cena.

## V1 stop rule

Po v1 sa neimplementuje živé volanie, SMS gateway, fleet dispatch ani auth. Platené Google API sú pripojené iba cez konfigurovateľný provider/fallback režim, nie ako tvrdá závislosť celej aplikácie.
