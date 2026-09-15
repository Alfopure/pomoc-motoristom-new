# DatabázaVozidiel.sk — API v3

## Kontrakt a konfigurácia

Overená dokumentácia: [Swagger v3](https://www.databazavozidiel.sk/api-dokumentacia/v3), [OpenAPI 3.0.1, Vehicle Info 3.0.1](https://www.databazavozidiel.sk/api-dokumentacia/v3/openapi.yaml). Serverový adaptér je `src/server/vehicle-lookup/providers/databazavozidiel.ts`.

- `GET https://www.databazavozidiel.sk/api/vehicles`
- Query: práve jeden z `ecv` alebo `vin`; `ek_tk_live=false`.
- Hlavičky: `Authorization: Bearer <serverový kľúč>`, `Version: 3`, `Accept: application/json`.
- Úspech: JSON `{ vehicle: { ... }, ektk?: { ... } }`. SwaggerHub mock server sa nepoužíva.
- `DATABAZA_VOZIDIEL_API_KEY` sa nastavuje iba na serveri správneho Vercel projektu `pomoc-motoristom-new`, pre Preview, Production a podľa potreby Development. Nikdy `NEXT_PUBLIC_`. Prázdna premenná vypína len tento zdroj; globálne vypnutie dohľadávania naďalej platí.
- Jedna platená požiadavka pri výslovnom dohľadaní, žiadne volanie pri každom znaku ani automatický retry API. Používa existujúcu rezerváciu a cache organizácie, bez migrácie, workera alebo cronu.
- Pevná HTTPS adresa, zakázané presmerovania, timeout najviac 9 s v spoločnom limite operácie, najviac 500 kB dekódovanej odpovede, `cache: no-store` na transporte.

`ek_tk_live=false` zabraňuje pomalému obnovovaniu kontrol pri zásahu. Čas načítania nie je potvrdením aktuálnosti evidencie. Termíny sa zobrazia iba s platným dátumom vykonania kontroly, ktorý nie je v budúcnosti; termín nesmie predchádzať vykonaniu.

## Mapovanie údajov

Adapter povoľuje iba známe technické polia. Každá hodnota zachováva zdroj a kvalitu `reported`. Chýbajúce, neplatné alebo nulové technické miery sa neodhadujú. Názvy vľavo sú presné kľúče v `vehicle`.

| API v3 | Interné pole / význam |
| --- | --- |
| `ecv`, `vin` | `plate`, `vin`; normalizované a overené identifikátory |
| `znacka`, `obch_nazov`, `farba`, `druh_paliva` | značka, model, farba, palivo |
| `druh_karoserie`, `kategoria`, `druh_vozidla` | karoséria, kategória, druh vozidla |
| `typ`, `typ_variant_verzia` | označenie typu a nerozdelený typ / variant / verzia |
| `vyrobca_vozidla`, `dat_prva_evid`, `dat_prva_evid_sr` | výrobca a prvé evidencie; dátumy D.M.RRRR → ISO |
| `objem`, `vykon`, `otacky`, `max_rychlost` | cm³, kW, ot./min, km/h |
| `cislo_motora`, `vyrobca_motora` | číslo motora a výrobca; číslo sa nepreznačuje za typ |
| `prevodovka`, `pocet_stupnov` | prevodovka (AT → Automatická, MT → Manuálna) a počet stupňov |
| `emisie_a_spotreba_es_ehk`, `pocet_miest` | emisná norma a sedadlá |
| `prevadzkova_hmotnost`, `hmotnost`, `pripustna_hmotnost_supravy` | prevádzková, prípustná hmotnosť vozidla a súpravy, kg |
| `najvacsia_pripustna_hmotnost_pripadajuca_na_napravu_1` … `_4` | hmotnosť každej uvedenej nápravy; nie súčet ani odhad, kg |
| `najvacsia_pripustna_hmotnost_pripojneho_vozidla_brzdeneho`, `…_nebrzdeneho` | samostatné hmotnosti brzdeného / nebrzdeného prívesu, kg |
| `pocet_naprav`, `pohanana_naprava_1` … `_4` | počet a čísla poháňaných náprav; neprekladať automaticky na predný/zadný pohon |
| `razvor_1` … `_4` | jednotlivé hodnoty rázvoru, mm |
| `rozmery_celkove_dlzka`, `…_sirka`, `…_vyska` | dĺžka, šírka, výška, mm |
| `pneumatiky_1` … `_4` | šírka/výška, konštrukcia, priemer ráfiku, index nosnosti/rýchlosti podľa nápravy |
| `rafiky_1` … `_4` | šírka, tvar pätky, priemer a zális ET podľa nápravy |
| `spajacie_zariadenie_trieda`, `…_typ`, `…_znacka` | dostupná identifikácia spájacieho zariadenia |
| `ektk.kmTkLastCheck`, `kmTkNextCheck`, `kmEkLastCheck`, `kmEkNextCheck` | dátumy vykonania a platnosti TK/EK; prísne ISO dátumy |

API môže poskytovať aj ďalšie údaje. Čísla dokladov, voľný text `dalsie_zaznamy`, kontakty/osobné údaje, alternatívne pneumatiky a nepoužívané emisné merania sa do snapshotu nekopírujú. Prvá evidencia nie je rok výroby. Hmotnosti rôznych kategórií a neurčený pohon sa nezamieňajú. Pri neúplných údajoch o pohone sa uvádzajú iba potvrdené nápravy s označením neznámeho zvyšku.

## Identita a PZP

EČV → API a STKonline súbežne → kontrola zhody → SKP podľa overeného VIN. API musí vrátiť platné VIN aj zhodnú EČV, aby vytvorilo túto väzbu. Nesúhlas identifikátora má stav `ambiguous`, bez technických faktov. Nesúhlas medzi zdrojmi blokuje prijatie výsledku. Pri chýbajúcom VIN sa SKP volá podľa zadanej EČV; po výslovnom `not_found` podľa VIN je povolený jeden fallback na pôvodnú EČV v zostávajúcom limite.

PZP poskytuje výhradne SKP. DatabázaVozidiel.sk nie je dôkaz poistenia. Ostatné zdroje: verejné STKonline a HAKA, API NHTSA vPIC. Diaľničná známka má iba odkaz na ručné overenie. Podrobnosti v [prevádzkovom postupe](./vehicle-lookup-operations.md).

## Chyby a prevádzka

| Odpoveď | Stav v aplikácii |
| --- | --- |
| 404 | `not_found`, žiadny záznam |
| 429 | `rate_limited`, vyčerpaná API kvóta podľa kontraktu; skontrolovať balík u poskytovateľa |
| 401 / 403 | `unavailable`, správca skontroluje kľúč a prístup |
| 422 | `unavailable`, poskytovateľ neprijal identifikátor; nejde o nenájdené vozidlo |
| Timeout, 5xx, neplatné JSON/telo/identita | `unavailable`, ostatné zdroje pokračujú |
| Chýbajúci kľúč | `unsupported`, žiadna API požiadavka |

Cache v4 zahŕňa stav zapnutia API. Zdravý výsledok vyžaduje nájdené API (alebo STK pri vypnutom API) aj SKP, bez konfliktov a technických chýb; platí najviac 15 minút. Čiastočné/chybové výsledky najviac minútu. Doplnenie kvóty sa preto prejaví pri ďalšom dohľadaní po krátkej cache bez nového nasadenia. Odobratie kľúča a nové nasadenie vypne platený zdroj.

Telemetria obsahuje iba zdroj, stav, trvanie a počet polí. Kľúč, celé živé odpovede a referenčné identifikátory nepatria do repozitára ani logov. Testy používajú syntetické identifikátory a mock HTTP; regresie pokrývajú identitu, mapovanie, dátumy, chyby, veľkosť, timeout a tok VIN → SKP.

Pri overení dodaného kľúča 15. 9. 2026 API vrátilo HTTP 429. Úspešné živé načítanie v3 preto zostáva závislé od dostupnej kvóty; túto odpoveď nemožno vydávať za úspešný test dát. Nasadenie prechádza pracovná vetva → Preview → PR do `dev` → overenie dev → PR `dev` do `main` → overenie produkcie.
