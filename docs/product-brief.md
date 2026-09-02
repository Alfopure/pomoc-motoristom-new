# Product Brief: Linka pomoci motoristom

## Cieľ demo verzie

V1 je klikateľné klientské demo pracovného dispečingu pre Pomoc Motoristom. Nejde o marketingový web ani produkčnú aplikáciu. Prvý viewport má ukázať reálny operačný deň: prichádza hovor, vzniká prípad, dispečer vyberá pobočku/techniku, kontroluje mapu, cenu, SMS preview, úlohy a reporting.

## Používatelia

- Operátor/dispečer: prijíma hovory, zakladá prípady, koordinuje odťah, náhradné vozidlo a spätné volania.
- Senior dispečer: sleduje kapacity, otvorené prípady, zmeškané hovory a problémy v dátach.
- Manažér: číta denné metriky, dovolateľnosť, dôvody odmietnutia a výkon služby.

## Aktuálny v1 foundation

V1 už nie je iba klikateľný mock. Supabase je hlavný zdroj dát pre prípady, kontakty, vozidlá, pobočky, techniku, úlohy a timeline. Operátor vie ručne založiť nový prípad cez Google Places adresy a zápisy idú cez serverové route handlery.

Samostatný modul `Flotila` rieši dennú dostupnosť náhradných vozidiel a odťahoviek. Operátor v ňom vidí, čo je voľné, rezervované, prenajaté, v servise alebo offline, na ktorej pobočke sa vozidlo nachádza, dokedy je obsadené a či končia doklady. `Integrácie` ostávajú technická obrazovka pre telefóniu (Telnyx), Google, Supabase a ďalšie napojenia, nie každodenná správa vozidiel.

Mapový foundation používa platené Google API ako primárny provider:

- `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY` pre Maps JavaScript API, Advanced Markers a Places našeptávač v browseri,
- `GOOGLE_MAPS_API_KEY` iba server-side pre interný `/api/maps/route` bridge nad Google Routes API,
- viditeľný stav mapy `Google live`, `Fallback` alebo `Routes unavailable`,
- deterministický fallback výpočet km/ETA/ceny a Leaflet/OSM fallback, ak Google mapa alebo Routes API zlyhá.

V1 stále neobsahuje reálne SMS odosielanie ani živú telefóniu (obe pribudnú s Telnyxom); telefónne UI beží v režime „Telefónia nie je nakonfigurovaná". Tieto integrácie sú pripravené ako provider adaptéry mimo UI.

## Traceability

Tento brief je odvodený z `docs/source/MOTORIST_ASSISTANCE_KNOWLEDGE_BASE.md`, najmä zo sekcií o hlavnej obrazovke, karte prípadu, mapách, MVP prototype a produkčnom roadmape.
