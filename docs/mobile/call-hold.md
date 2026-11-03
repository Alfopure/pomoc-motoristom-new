# Podržanie hovoru v mobilnom dispečingu

Pri externom spojenom hovore ponúka mobil „Podržať hovor“ a po potvrdení
ústredne „Obnoviť hovor“. Používa existujúce konferenčné podržanie zákazníka
s hudbou. Stíšenie vlastného mikrofónu má samostatné ovládanie. Interné hovory
kolegom zatiaľ túto možnosť neponúkajú: existujúca konferenčná topológia
neposkytuje obom stranám rovnaké bezpečné ovládanie.

## Potvrdenie a obnova

Systémová CallKit akcia aj tlačidlo v aplikácii používajú jeden presný príkaz.
Jeho UUID, požadovaný stav, pôvodná verzia relácie a mobilná provider vetva
sa pri neistom výsledku nemenia. Natívna vrstva musí ešte pred HTTP potvrdiť,
že akcia nevypršala a patrí aktuálnemu hovoru. Po vypršaní sa nová oneskorená
požiadavka nezačne. Už odoslaná požiadavka zostane dostupná na overenie aj
po obnove JS.

Server kontroluje aktuálnu mobilnú lease a skutočne prijatú otvorenú mobilnú
vetvu pod existujúcim zámkom relácie. Vlastníctvo účtu, senior rola ani právo
ukončiť starý hovor neposkytujú právo meniť jeho audio. Podržanie používa
existujúci jadrový príkaz, nahrávacie pravidlá a provider journal.

Samotný stav databázy `held` nepotvrdzuje vykonanú operáciu: jadro ho môže
zapísať pred provider odpoveďou. API vracia oddelene aktuálny potvrdený stav
média a historický výsledok pôvodného príkazu. Nevykonaný, preskočený alebo
nejasný provider príkaz nesmie vyzerať ako úspech. Verzia relácie zabraňuje
návratu k staršiemu stavu; dokončenie provider operácie môže potvrdiť médium
aj v tej istej verzii.

Pri nejasnej odpovedi ostane ďalšie prepnutie zablokované. „Overiť stav
podržania“ iba číta výsledok pôvodnej požiadavky. Chýbajúci záznam nie je
dôkazom, že pôvodná požiadavka ešte nemôže prísť. Ukončenie hovoru zostáva
dostupné. Starý úspešný príkaz sa po neskoršom obnovení hovoru znovu nevykoná.
Zmena vykonaná na webe sa zosúladí s CallKitom bez ďalšieho provider príkazu.
Potvrdenie ústredne samo neodblokuje ďalšie prepnutie: mobil čaká aj na
potvrdenie presnej systémovej akcie. Stratené udalosti obnoví čítaním
aktuálneho natívneho stavu; samotná neprítomnosť rozpracovanej akcie nestačí.

## Mikrofón a systémové ovládanie

Natívna ochrana mikrofónu je oddelená od používateľského stíšenia. Platí
počas podržania aj neistého obnovovania, kým ústredňa nepotvrdí aktívne
médium a CallKit sa nezosúladí. Používateľská voľba stíšenia zostáva zachovaná.
Obnova SDK spojenia musí zachovať túto ochranu pred vytvorením nového
odosielajúceho zvukového spojenia; neskoré stíšenie v JS by nestačilo.

[Apple CXSetHeldCallAction](https://developer.apple.com/documentation/callkit/cxsetheldcallaction)
slúži na podržanie aj obnovenie. Natívna časť dokončí akciu až po overení
výsledku. Podľa [Apple pravidiel pre timeout](https://developer.apple.com/documentation/callkit/cxproviderdelegate/provider(_:timedoutperforming:))
sa už vypršaná akcia dodatočne nedokončuje ani nezamieta. Timeout podržania
sám neukončuje živý hovor.

## Rozhranie

Všetky požiadavky sú autentifikované `POST` pod `/api/mobile/v1/voice/calls/[id]`.
Odpovede ostávajú privátne a viazané na mobilný profil a TEST prostredie.

| Cesta | Účel |
| --- | --- |
| `status` | Aktuálne spojenie, ukončenie a potvrdené médium |
| `hold` | Presný nový alebo totožný pôvodný príkaz |
| `hold/status` | Iba čítanie výsledku pôvodného príkazu |

Telo podržania aj jeho overenia: `deviceSessionId`, `callControlId`,
`requestId`, `held` a `expectedVersion`. `media` obsahuje aktuálnu `version`,
`state` (`active`, `held`, `pending`, `unavailable`), `canHold` a
`callControlId`. `operation` obsahuje pôvodné `requestId`, `held` a výsledok
`accepted`, `pending`, `rejected` alebo `not_found`. Historické `accepted`
nenahrádza aktuálny stav média.

## Akceptácia

Automatizované kontrolované skúšky overujú poradie, identity, odmietnutia,
obnovu, oneskorené výsledky a opakovanie. Cloudový natívny build overuje
kompiláciu a spustenie s frameworkmi. Tieto dôkazy nenahrádzajú fyzické audio.

Na podpísanom TEST iPhone treba overiť podržanie aj obnovenie z aplikácie
aj systémového ovládania, zákaznícku hudbu, súbeh s webom, zachovanie
používateľského mute a Bluetooth. Osobitne overiť stratu HTTP odpovede pri
obnovení, Wi-Fi ↔ dáta, SDK ATTACH, zamknutie a vypršanie CallKit akcie:
žiadny predčasný prenos mikrofónu, duplicitný príkaz ani ukončenie iného
hovoru. Postup po získaní Apple podpisu je v [iPhone TEST runbooku](iphone-voice-test.md).
