# Plán: AI pomocníčka v reálnej prevádzke

Stav: **implementácia neschválená**. Revízia 3 — po druhom kole Architect + Critic (oba vrátili blokujúce nálezy) — po nezávislých priechodoch Architect a Critic. Nadväzuje na `.context/ralplan-v2/drafts/plan-v4.md` a `ai-demo-plan.md` (fázy 0–2, hotové). Metodika RALPLAN-DR, deliberate režim (produkcia, migrácie, osobné údaje).

**Autorizuje:** nič. Kód, migrácie, nasadenie ani živé hovory nie sú týmto dokumentom schválené.

---

## 0. Čo revízia 2 opravila

Prvá verzia opierala tri rozhodnutia o tvrdenia, ktoré kód nepotvrdil. Sú tu vypísané, lebo dve z nich sa opakovali aj v ústnej komunikácii.

| Tvrdenie v1 | Skutočnosť | Dôsledok |
|---|---|---|
| ~~„Test drží strop 2 000 znakov promptu" — neexistuje~~ | **Tento „nález" bol nesprávny a revízia 4 ho ruší.** Test existuje: `prompts.test.ts:22`, `toBeLessThan(2_000)` pre každý scenár. Neviditeľný bol preto, že súbor obsahoval **surový NUL bajt** (testovacie dáta pre sanitizáciu na riadku 171), a `grep` taký súbor považuje za binárny a mlčí | P2 **má** poistku a vždy mal. Bajt nahradený escape sekvenciou, takže nástroje súbor opäť vidia |
| „Pri možnosti B sa ring plán nemení ani o riadok" | `ring-plan.ts:107,113` má `personal_mobile` ako literál; `'ai'` by vyžiadalo zmenu vo `materialiseRingPlan`, ktorý beží pri **každom** ľudskom hovore | Jediná výhoda B padla. Voľba sa zmenila |
| „Rozpočet 300 s, max 800 s" | `listen/route.ts:19` je `maxDuration = 320` | R4 prepísané |
| „Server dopĺňa príjemcu SMS, takže je to vždy volajúci" | `sms-workflow.ts:90`: `context?.toNumber` (kontakt prípadu) **vyhráva** nad vstupom | AK 17 musí byť tvrdá kontrola rovnosti, nie spoliehanie sa |
| „Denný strop na SMS na číslo, spoločný s ľudskými" | Neexistuje. V `sms-workflow.ts` ani `lib/sms/` nie je rate limit | Buď sa postaví, alebo sa netvrdí. Plán ho stavia |

**Revízia 3 pridáva:**

| Tvrdenie v2 | Skutočnosť | Dôsledok |
|---|---|---|
| „Server pozná číslo volajúceho z hovoru" | Pri hovore cez ring skupinu **nie.** `transitions.ts:895` posiela `fromNumber`, `session-runner.ts:381` ho berie z overeného originačného čísla — teda **našej linky** | Nová §4.1. Dotýka sa vyhľadania, SMS kontroly aj počítadla overovania |
| „Rozpočet 320 s" | `config.ts:380` klampuje dĺžku hovoru na **300 s**; 320 je len rezerva funkcie | R4, AK 29 |
| „Predbežné načítanie odstráni okružnú cestu" | Len ak prípad skončí v kontexte modelu **pred** overením — čo zakazuje P4 | §5.2 prepísané |
| ~~Komentár `prompts.ts:247` klame~~ | **Zrušené revíziou 4.** Komentár je pravdivý — `prompts.test.ts:13` konštantu importuje aj testuje. Rovnaká príčina: NUL bajt |
| „Na deve je okruh volajúcich uzavretý" | Nič neallowlistuje prichádzajúcich. Allowlist je len na **ciele** odchádzajúcich (`ring-plan.ts:115`) | §4 prepísané na fail-closed prepínač |

---

## 1. Čo sa mení oproti demu

Demo je nástroj v admin záložke. Produkcia z nej robí **kolegyňu s účtom**: profil, prítomnosť, pridelená linka, zvoní jej ring plán, jej úkony majú autora v rovnakom audite ako ľudské.

| Zistenie | Kde | Dôsledok |
|---|---|---|
| `motorist_profiles.user_id` je nullable | `foundation_schema.sql:56` | Účet bez prihlásenia je legitímny stav |
| Operátor dosiahnuteľný na čísle už existuje | `ring-plan.ts:110-124`, `eligibility.ts` | Netreba nový druh člena ani nový `delivery_mode` |
| Nástroje žijú len v `delegation.responses.tools` a vyžadujú listener | `research/06-openai-gpt-live-contract.md:213` | Listener existuje — drží prepis |

---

## 2. RALPLAN-DR

### Princípy

**P1 — Kritická cesta sa nepredlžuje.** Namerané: zdvihnutie → prvé slovo ~1,0 s; volajúci dohovorí → ona začne 0,2–1,1 s.

**P2 — Hlasový prompt sa nepredlžuje.** Stráži to test `prompts.test.ts:22` (2 000 znakov na scenár) a ten prechádza — 41 testov promptu je zelených. **Dôsledok pre §8:** 600-znakové pole pravidiel sa pod ten strop nezmestí bez toho, aby sa iné odobralo. Buď klesne strop poľa, alebo sa prompt skráti; rozhodne sa meraním, nie odhadom.

**P3 — Hovory na ostatné čísla zostávajú nedotknuté.** *Preformulované.* v1 tvrdila „ľudské hovory nedotknuté"; fáza 5 nutne pridáva vetvu do prichádzajúcej cesty (§5.1). Princíp sa preto viaže na **cieľové číslo**, nie na celú cestu, a je overiteľný (AK 19–21).

**P4 — Hranice sú v kóde, nie v zadaní.**

**P5 — Nič sa nezapína samo.**

### Rozhodovacie faktory

1. Ochrana údajov volajúcich — únik je nezvratný.
2. Latencia pri nástrojoch.
3. Veľkosť zásahu do zvonenia.

### Možnosti — ako sa k nej dovolá ring plán

Po oprave §0 sa porovnanie obrátilo.

| # | Možnosť | Pre | Proti | Verdikt |
|---|---|---|---|---|
| **A** | **Existujúci mechanizmus: `delivery_mode = 'personal_mobile'` + jej DID; AI-ness nesie `profiles.kind='ai'`** | **Nula zmien v `ring-plan.ts` a `eligibility.ts` — P3 platí doslova. Prítomnosť, preskočenie pri obsadení a `on_call` fungujú dnes** | **Pomenovanie „osobný mobil" pre AI; v UI treba vysvetliť** | **Zvolené** |
| B | Nový `delivery_mode = 'ai'` | Presnejší názov | Literál `personal_mobile` je v ~10 súboroch (`ring-plan.ts:107,113`, `operator-settings.ts:16`, `config-service.ts:1269`, `active-calls.ts:296`, `presence.ts:29,132,160`, `operators-model.ts:40,164,316`, `database.types.ts:1428`). Zmena vo `materialiseRingPlan` beží pri každom ľudskom hovore | Zamietnuté |
| C | `delivery_mode='ai'` s priamym SIP vytočením | Bez hopu cez sieť | Nová vetva vo vytáčaní členov = P3 | Odložené, §9 |
| D | Nový `member_kind='ai'` | Koncepčne čisté | Všetko z B plus CHECK a validácia | Zamietnuté |

**Známe obmedzenie voľby A.** Po prepise je členkou typu `external_number`, a fronta pri opakovanom ponúkaní filtruje `member.kind === "operator"` (`transitions.ts:1050`). **Na vetve opakovaného ponúkania z fronty sa k nej teda hovor nedostane** — zvoní jej v bežných krokoch plánu, nie pri re-offeri. Platí to rovnako pre operátorov na súkromnom mobile, takže to nie je regresia, ale patrí to do popisu, čo „záloha v skupine" znamená.

**Prečo sa voľba zmenila.** v1 zamietla A pre „klamlivý dátový model". To bola estetika, nie argument — a bola jediným dôvodom pre B. `personal_mobile` navyše v skutočnosti znamená „dosiahnuteľný na čísle, nie v prehliadači", čo o nej platí. Že je to AI, je vidieť z `profiles.kind` a UI to podľa toho popíše.

### Možnosti — kde sa vykonávajú nástroje

| # | Možnosť | Pre | Proti | Verdikt |
|---|---|---|---|---|
| **B1** | **Predbežné načítanie pri prijatí + nástroje v existujúcom listeneri** | **Najčastejšiu otázku („v akom stave je môj prípad") zodpovie bez okružnej cesty; nula nových procesov** | **Rozpočet funkcie ohraničuje hovor s nástrojmi** | **Zvolené** |
| B2 | Druhý listener len na nástroje | Oddelené záujmy | Druhý socket; `AGENTS.md` bod 7 | Zamietnuté |
| B3 | Bez nástrojov, všetko po hovore | Nula latencie | Nevie odpovedať na doplňujúcu otázku ani založiť prípad v hovore | Zamietnuté — ale **jeho jadro sa prebralo**: predbežné načítanie |

**Predbežné načítanie — opravené v revízii 3.** v2 tvrdila, že bežný hovor nepotrebuje ani jedno volanie nástroja. To by platilo len vtedy, keby prípad skončil v kontexte modelu **pred** overením EČV — a potom by hranicu strážil prompt, nie kód (P4).

Načítanie preto plní **serverovú pamäť viazanú na pokus, nie kontext modelu.** Model nedostane o prípade nič, kým `over_ecv` neprejde; potom dostane povolené polia.

**Čo tým získame a čo nie, bez prikrášlenia:** okružná cesta zostáva — model si o údaje musí povedať. Ušetrí sa len jej *dĺžka*, lebo odpoveď je už v pamäti. Rezerva v accept ceste navyše existuje preto, že *telefón ešte nezvoní* (`orchestrator.ts:344-350`) — čo platí pri odchádzajúcom hovore. Pri prichádzajúcom zákazník už na linke je, takže načítanie tam beží súbežne s vytáčaním SIP, nie pred pozdravom.

---

## 3. Dátový model

Aditívne migrácie.

| # | Migrácia | Čo |
|---|---|---|
| M1 | `motorist_profiles` + `kind text not null default 'human' check (kind in ('human','ai'))` | Odlíšenie účtu |
| M2 | Nová `motorist_ai_agent_settings` (riadok na organizáciu) | Meno, hlas, oslovenie, pravidlá, oprávnenia, SMS |
| M3 | Nová `motorist_ai_tool_calls` | Pokus, výsledok, trvanie, dôvod zamietnutia |
| M4 | `motorist_cases` + `ai_draft boolean not null default false`, `ai_confirmed_at timestamptz` | Návrh na potvrdenie bez nového stavu |
| M5 | Nová `motorist_ai_verification_attempts` (**prípad**, deň, počet) + globálny denný strop | Počítadlo overovania naprieč hovormi. **Kľúčom je prípad, nie číslo volajúceho** — číslo si útočník volí sám, takže ako kľúč nechráni pred ničím |
| M6 | Nová `motorist_sms_daily_caps` alebo stĺpec v existujúcej dennej štatistike | Denný strop SMS na číslo (§0) |

**M4 nepridáva hodnotu do `status`** — zoznam stavov je zmluva, na ktorej visia filtre a prehľady.

**M3 nie je duplicita auditu.** Audit zaznamená následok, `motorist_ai_tool_calls` pokus — vrátane zamietnutých a vypršaných. Bez toho sa nedá ladiť, prečo mlčala.

---

## 4. Ochrana údajov — prepracované

Critic ukázal, že pôvodný návrh sa dá obísť. Tri diery a čo ich zatvára.

| Diera | Ako sa zneužije | Čo ju zatvára |
|---|---|---|
| Sama ponúkla prípad pred overením | „vidím u vás prípad z 12. marca" prezradí existenciu a dátum pri nulovej znalosti | **Neponúka nič.** Spýta sa „s čím voláte?" a až po overení potvrdí |
| Počítadlo troch pokusov bolo na hovor | Zavolá znova a počítadlo sa nuluje → neobmedzená veštiareň | **M5: počítadlo na číslo a deň**, nie na hovor |
| EČV je verejný údaj | Je napísaná na aute; kto si vozidlo vyhliadol, má ju | Viď nižšie |

**O EČV — rozhodnutie je tvoje a plán ho rešpektuje, ale musím pomenovať, čo som pri revízii zistil.** EČV nie je tajomstvo: je na aute zvonku, na fotke, na kamere. Ako jediná kontrola chráni pred náhodným omylom, nie pred niekým, kto si konkrétne vozidlo vybral. Podvrhnúť číslo volajúceho je pritom bežná vec a nič v systéme to neoveruje.

Plán preto **ponecháva EČV** ako kontrolu, ale rozdeľuje, čo si ňou možno odomknúť:

| Po overení EČV | Vyžaduje viac |
|---|---|
| Že prípad existuje a v akom je stave | Adresa, meno, telefón, cena |
| Že termín je dohodnutý a kedy | Obsah poznámok, údaje tretích osôb |

**Rozhodnuté (2026-09-20): EČV odomyká všetko počas testu. Revízia 3 mení, čím sa to vynúti.**

v2 to viazala na `environment`. To je nebezpečné: `runtime.ts:33-35` odvodzuje hodnotu z `VERCEL_ENV` a pri jej absencii vráti `development` — **zlyháva otvorene**. Navyše adresu listenera určuje `AI_DEMO_WEBHOOK_BASE_URL`, nezávisle od `VERCEL_ENV`; nasmerovať reálne číslo na dev alias je presne dev-first postup, a plné odomknutie by tak dostal reálny volajúci.

Rozsah preto riadi **vlastný prepínač, ktorý zlyháva zatvorene**: `AI_DEMO_FULL_DISCLOSURE`. Nenastavený = zamknuté. Zapnúť sa dá len vedome a len tam, kde nie sú cudzie dáta.

**Čo je v databáze dnes (zmerané 2026-09-20):** 16 prípadov, 14 kontaktov, 16 vozidiel, 245 hovorov, od 2026-05-20. To je objem testovania — žiadne cudzie zákaznícke záznamy. **Na tom stojí rozhodnutie majiteľa a platí, kým to platí.** Prvý import reálnych dát = prepínač dole.

| `AI_DEMO_FULL_DISCLOSURE` | Po overení EČV |
|---|---|
| nenastavené *(predvolené)* | stav a termín; citlivý stĺpec zamknutý |
| `true` | **všetko** — stav, termín, adresa, meno, telefón, cena |

**Prečo vlastný prepínač, a nie prostredie.** Prostredie popisuje *nasadenie*, nie *dáta*; `motorist_cases` stĺpec `environment` nemá a mať nebude. A zlyháva otvorene. Prepínač zlyháva zatvorene (P5) a dá sa naň napísať test.

Kontrola cez **číslo prípadu** (vydávame ho my, chodí v SMS `case_received`) je follow-up a je **podmienkou** pre odomknutie citlivého stĺpca v produkcii.

**Vedome prijaté zostatkové riziko:** v `development` vidí po EČV celý prípad ktokoľvek, kto na ňu zavolá a EČV pozná. Prijaté, lebo okruh volajúcich je uzavretý.

### 4.1 Kto je vlastne volajúci

Pri hovore cez ring skupinu **nesie jej leg ako volajúceho našu vlastnú linku**, nie zákazníka (`transitions.ts:895`, `session-runner.ts:381`; komentár tam vysvetľuje prečo — volať smie len overené originačné číslo). v2 na tom postavila vyhľadanie prípadu, kontrolu príjemcu SMS aj pravidlo pri skrytom čísle. Všetky tri by pri hovoroch cez skupinu pracovali s naším číslom a každý taký hovor by vyzeral ako ten istý volajúci.

Zákazník sa dohľadá cez reláciu, nie cez `from`:

| Ako hovor prišiel | Odkiaľ je číslo zákazníka |
|---|---|
| Priamo na jej číslo | `from` jej legu |
| Cez ring skupinu | `motorist_call_legs` → `session_id` → leg s `role='customer'` → jeho `from_number` |

Je to jeden join na serveri, takže záruka z §5 („model nemá pole *koho*") zostáva nedotknutá. Keď sa zákazník dohľadať nedá, **nečíta nič** — nehádа sa.

**Ďalšie hranice:**
- EČV nikdy nepovie ona. Musí ju povedať volajúci
- Skryté číslo → nečíta nič a povie to
- Viac prípadov na jedno číslo → nevymenúva ich; nechá volajúceho povedať, o ktorý ide
- Prípad bez vozidla (`license_plate` je nullable) → kontrola sa nedá vykonať; povie len, že sa ozve kolega

---

## 5. Nástroje

Deklarujú sa v `delegation.responses.tools`, vykonáva ich listener. **Registrujú sa len zapnuté** — čo je vypnuté, model nevidí.

| Nástroj | Čo dostane | Strop |
|---|---|---|
| *(predbežné načítanie pri prijatí)* | nič — server podľa čísla hovoru | mimo hovoru |
| `over_ecv` | EČV, ktorú povedal volajúci | 400 ms |
| `zaloz_navrh_pripadu` | zhrnutie, typ, poznámka | 1 500 ms |
| `pridaj_poznamku` | text | 1 000 ms |
| `posli_sms` | kľúč šablóny | 1 500 ms |

Žiadny nástroj neprijíma telefónne číslo ani identifikátor inej osoby. **Model nemá ako sa spýtať na cudzí prípad, lebo pole „koho" neexistuje.**

### 5.1 Ako sa to zapojí (HOW, nie iba WHAT)

Toto je jadro fázy 2 a v1 ho nešpecifikovala.

1. `acceptBody` v `openai-live.ts` dnes zámerne **neposiela** `tools` (`:69-71`). Pribudne `delegation.responses.tools` a `tool_choice: "auto"`
2. Listener v `greeting.ts` dnes parsuje tri ploché polia. Volanie funkcie prichádza v inom tvare a **schému nemáme overenú** — výskum popisuje návrat výsledku (`response.item.create` + `response.create`), nie tvar požiadavky
3. Vykonávač beží v tej istej funkcii, medzi checkpointmi prepisu
4. Výsledok späť cez `response.item.create` (`function_call_output`) + `response.create`

**Fáza 2 preto začína spikom (pol dňa): dokázať jednu obrátku volania funkcie na sidebande.** Kým to neprejde, nestavia sa na tom nič. Ak sa ukáže, že sideband volanie funkcie nedoručí, padá sa na predbežné načítanie + zápis po hovore, a zápis v hovore sa odkladá.

### 5.2 Latencia

Predbežné načítanie odstraňuje okružnú cestu z bežného hovoru. Keď nástroj predsa beží, platí pravidlo myslieť nahlas a pri vypršaní neopakuje — povie, že nenašla, a ponúkne spätné volanie. `reasoning.effort` nízky, hlasová hlava reasoning nemá (P1).

**Poistka proti nemému socketu:** strop beží na našej strane. Keď z listenera nepríde nič, vetu o nenájdení povie tak či tak. Dnes je mŕtvy probe len stratené meranie; s nástrojmi by to bolo ticho.

---

## 6. Oprávnenia podľa toho, kto je na linke

| | Sama s volajúcim | Pripojená dispečerom |
|---|---|---|
| Čítanie | len prípad viazaný na číslo | plný prístup |
| Kontrola | áno | **nie** — ručí dispečer |
| Zápis | návrh na potvrdenie | môže zakladať |
| Zatváranie, ceny, editácia | nikdy | nikdy |

Pripojiť ju smie každý dispečer. Režim sa odvodzuje z toho, že v relácii existuje **leg s neprázdnym `profile_id` patriacim profilu s `kind='human'`** — nie z prepínača, ktorý by sa dal nechať zapnutý.

---

## 7. SMS

**Povolené šablóny:**

| Šablóna | Podmienka |
|---|---|
| `case_received` | prípad vznikol v tomto hovore |
| `location_request` | prípad existuje a nemá miesto |

`callback` **vypadla** — jej text znie „Nepodarilo sa nám vás zastihnúť, prosím zavolajte nám" (`templates.ts:47`), čo je uprostred hovoru nezmysel. `eta_update`, `delay`, `tow_destination` oznamujú rozhodnutie dispečingu. `custom` nikdy.

**Vynútené serverom:**
- **Tvrdá kontrola rovnosti** príjemcu s číslom hovoru **pred** odoslaním. Nestačí sa spoľahnúť na doplnenie — `sms-workflow.ts:90` dáva prednosť kontaktu prípadu pred vstupom (§0)
- Najviac 1 za hovor (nastaviteľné, strop 3)
- Nie v prvých 20 sekundách
- Denný strop na číslo — **M6, stavia sa v tejto fáze**
- Musí to povedať nahlas skôr, než odošle
- Znovu použije `prepareSms` + `sendPreparedSms`, nie nová cesta

Hlavný prepínač predvolene vypnutý (P5).

---

## 8. Nastavenia

**Identita:** meno (2–20 znakov, predvolene Veronika), hlas, oslovenie. Rod sa odvodzuje z hlasu; pri nesúlade panel upozorní, nezakáže.

**Dostupnosť:** jeden prepínač online/offline a živý stav. Kedy dvíha = ring plán.

**Linka — bez tretieho miesta na nastavenie.** Prideľovanie už existuje a je per-operátor:

| Čo | Kde to už je |
|---|---|
| Z akej linky volá von | `motorist_operator_telephony_settings.default_from_line_id` |
| Kde ju zastihne zvonenie | `default_mobile_number` + `delivery_mode` |

V jej nastaveniach bude ten istý ovládač ako u operátorov a odkaz do záložky Čísla.

**Správanie:** jedno pole. Strop **odvodí sa od zostatku pod 2 000-znakovým stropom promptu** (P2), nie od okrúhleho čísla. Meria sa v teste, takže sa nedá potichu prekročiť. Predvolené znenie (334 znakov):

> Hovor vecne a priateľsky, bez zbytočných fráz. Jedna otázka naraz a počkaj na odpoveď. Keď niečo hľadáš, povedz to nahlas. Neopakuj, čo klient už povedal. Keď odpoveď nevieš, priznaj to a sľúb, že sa ozve kolega — nevymýšľaj si. Nesľubuj cenu ani termín. Na konci zhrň, čo ste dohodli, a rozlúč sa.

**Hranice:** zoznam len na čítanie. Oznam o nahrávaní sa nekopíruje — `announcements-service.ts:93-99` ho už má.

---

## 9. Fázy

| Fáza | Obsah | Kritická cesta | Odhad |
|---|---|---|---|
| **1** | Účet, `kind`, vylúčenie z prideľovania a notifikácií, prítomnosť, obrazovka, meno do zadania, **test na 2 000 znakov** | nie | **3 dni** |
| **2** | **Spike: obrátka volania funkcie.** Potom predbežné načítanie, `over_ecv`, M5, nahrávanie | nie | 2 dni |
| **3** | `zaloz_navrh_pripadu`, `pridaj_poznamku`, potvrdzovanie | nie | 1,5 dňa |
| **4** | `posli_sms` + M6 denný strop | nie | 1 deň |
| **5** | Prichádzajúce hovory, jej DID, ring cez `personal_mobile`, **dohľadanie zákazníka cez reláciu (§4.1)** | **áno** | 3,5 dňa |
| **6** | Prepojenie dispečerom | nie | 1 deň |

**Spolu ≈ 12 dní.** (v1: 8, v2: 11. Rast je fáza 1 — profil sa dotkne viac miest, než v1 čakala — a fáza 5, ktorá musí dohľadávať zákazníka cez reláciu.)

**Prečo fáza 1 narástla na 3 dni.** Profil sa objaví v dopytoch, ktoré ju nečakajú — prideľovanie úloh, notifikácie, zoznamy operátorov. `motorist_profiles` sa číta na desiatkach miest a `kind` je nový predikát, ktorý žiadne z nich neuplatňuje. Buď sa prejdú, alebo sa pridá jeden pomocník na vylúčenie a použije sa vo výpisoch. Odhad 1,5 dňa v v1 počítal len s migráciou.

**Prečo nástroje pred prichádzajúcimi hovormi.** Odchádzajúca cesta je overená ôsmimi živými hovormi a latencia na nej zmeraná. Robiť obe neznáme naraz znamená nevedieť, ktorá za to môže.

### 9.1 Fáza 5 — čo sa naozaj dotkne ľudskej cesty

v1 to zamlčala. Prichádzajúci hovor na jej číslo **nenesie `client_state`** — značka, na ktorej stojí dnešná izolácia dema. Padol by teda do `findSession` → `createInboundSession` a vytvoril by dispečerskú reláciu, ktorá by sama zvonila ring plánom.

Odbočka preto musí byť **podľa cieľového čísla**, pred `createInboundSession`. To je zmena v ceste, ktorou idú všetky prichádzajúce hovory — preto preformulované P3 a preto AK 19–21 s metódou.

---

## 10. Čo sa nerobí

| Čo | Prečo |
|---|---|
| Naliehavé hovory a eskalácia | Parkované na tvoju žiadosť |
| Viac hovorov naraz | Jeden; `on_call` ju preskočí |
| Priame SIP vytočenie (C) | Až po zmeraní R5 |
| Editovanie prípadov | Pripravené dátovo, nezapnuté |
| Zatváranie, ceny, partneri, termíny | Nikdy |
| Vlastné SMS, vlastné volanie | Nikdy |

---

## 11. Akceptačné kritériá

Každé s metódou. Prepísané tie, ktoré Critic označil za neoveriteľné.

**Účet**
1. Pokus zviazať `user_id` s profilom `kind='ai'` skončí chybou — test proti `access-management.ts`, nie tvrdenie o schéme
2. `offline` → v `motorist_ring_attempts` nevznikne riadok s jej `profile_id`
3. Kým hovorí, prítomnosť je `on_call` a druhý hovor ju preskočí — integračný test nad `materialiseRingPlan`
4. Premenovanie zmení jej predstavenie v ďalšom hovore; zoznam dotknutých miest je uzavretý testom na `buildStartupInstructions`
5. Neobjaví sa v prideľovaní úloh ani v notifikáciách — test nad výpismi, ktoré čítajú `motorist_profiles`

**Ochrana údajov**
6. Žiadny nástroj nemá v schéme parameter pre číslo ani identifikátor osoby — test na tvar
7. **Pred overením nedostane model o prípade nič** — deterministický test nad telom `accept` a nad návratovou hodnotou nástroja, nie posudzovanie prepisu
7b. Rozsah po overení riadi `AI_DEMO_FULL_DISCLOSURE`; nenastavený = citlivý stĺpec nevydá — test pre obe hodnoty **a pre chýbajúcu premennú**
7c. Keď sa zákazník nedá dohľadať (§4.1), nečíta nič — test pre obe cesty príchodu
8. Tri nezhody EČV **na prípad a deň** → ďalší hovor ten prípad neoveruje; navyše globálny denný strop pokusov
9. Skryté číslo → neprečíta nič
10. Viac prípadov na číslo → nevymenuje ich
11. Prípad bez EČV → kontrola sa nevykoná a nepovie obsah
12. Logy **jej vetvy** neobsahujú čísla, kľúče ani obsah prípadov — test nad zachytenými logmi z integračného behu. *(Pozn.: `event-processor.ts:129` loguje `phone_number` na existujúcej ceste; to je mimo rozsahu tohto plánu a kritérium sa naň nevzťahuje.)*

**Latencia (P1)**
13. Čas do prvého slova: medián z 5 hovorov **nestúpne o viac než 150 ms** oproti nameranému ~1,0 s
14. Medzera bez nástroja zostáva v pásme 0,2–1,1 s (medián z 5)
15. **Medzera pri úspešnom volaní nástroja** — hodnota sa **odvodí až po spike** (§5.1), lebo obrátka nástroja nebola nikdy meraná. Do vtedy je to otvorená položka, nie číslo vycucané z prsta
16. Pri vypršaní nástroja povie náhradnú vetu do 300 ms od stropu — merané, nie posudzované
17. Keď listener zomrie, povie náhradnú vetu tak či tak

**Zápis**
18. Prípad od nej má `ai_draft=true`, `owner_id` = jej profil, a nefiguruje v bežných prehľadoch
19. Potvrdenie nastaví `ai_confirmed_at` a zapíše audit s profilom dispečera
20. Nástroje na zatvorenie ani na cenu neexistujú — test na zoznam registrovaných nástrojov

**SMS**
21. Šablóna mimo povolených → odmietnuté
22. Príjemca ≠ číslo hovoru → odmietnuté **explicitnou kontrolou**, overené aj pre prípad s iným kontaktom
23. Druhá SMS nad limit → odmietnutá a zapísaná do `motorist_ai_tool_calls`
24. Prekročený denný strop na číslo → odmietnuté

**Izolácia (fáza 5)**
25. Prichádzajúci hovor na iné číslo: vzniknú tie isté efekty ako pred zmenou — porovnanie postupnosti typov príkazov a prechodov, s ignorovaním UUID a časov
26. Pri `offline` ide hovor aj na jej číslo dnešnou cestou — teda **vrátane** vzniku dispečerskej relácie
27. Hovor na jej číslo **pri zapnutom stave** nevytvorí riadok v `motorist_call_sessions`. *(v2 to tvrdila bezpodmienečne a odporovalo to AK 26.)*
28. Ring plán bez nej sa správa identicky — existujúce testy `event-processor` bežia bez zmeny

**Rozpočet**
29. Vyčerpanie **300 s** (`config.ts:380`) ukončí reláciu korektne a prepis sa nestratí
30. Pri chýbajúcom `VERCEL_ENV` ani pri chýbajúcom `AI_DEMO_FULL_DISCLOSURE` sa nič neodomkne — test na zlyhanie zatvorene

---

## 12. Pre-mortem

**Scenár 1 — Povie údaje niekoho iného.** *Príčina:* podvrhnuté číslo volajúceho, EČV odčítaná z auta. *Drží to:* nástroj bez parametra; neponúka prípad pred overením (AK 7); počítadlo na číslo a deň (AK 8); druhý stĺpec údajov len na číslo prípadu (§4). *Zostatkové riziko:* kto má EČV aj podvrhnuté číslo, zistí stav prípadu. Vedome prijaté — alebo sa prepne primárna kontrola na číslo prípadu.

**Scenár 2 — Zahltí dispečing návrhmi.** *Príčina:* založí prípad z každého omylu. *Drží to:* návrh len po potvrdení v hovore; `ai_draft` ich drží mimo prehľadov (AK 18); počet za deň je v „Čo robila". *Prah a kto ho vynúti:* nad 20 nepotvrdených za deň sa v paneli zobrazí upozornenie a **admin vypne zápis ručne**. Toto je vedome **nevynútené** — automatika naprieč hovormi by potrebovala vyhodnocovač a jediné povolené miesto je cron `*/5`. Ak sa ukáže, že to ručne nikto nerobí, presunie sa tam.

**Scenár 3 — Ticho počas nástroja.** *Príčina:* nástroj prekročil strop, alebo listener zomrel. *Drží to:* predbežné načítanie (bežný hovor nástroj nepotrebuje); stropy v §5; náhradná veta na našej strane aj pri mŕtvom sockete (AK 17). *Prah:* AK 15, odvodený po spike. Prekročenie v dvoch hovoroch = admin vypne nástroj v nastaveniach. Tiež **nevynútené** — rovnaký dôvod ako vyššie.

---

## 13. Riziká

| # | Vec | Stav |
|---|---|---|
| R1 | Prepne sa prítomnosť na `on_call` pri legu na jej číslo? | **Pravdepodobne áno** — `resolvePersonalRingMembers` nastavuje `profileId: owner` a leg nesie `profile_id`. Doveriť testom AK 3 |
| R2 | `resolvePersonalRingMembers` beží len pri `telephonyStabilityEnabled()` (`ring-plan.ts:198`) | **Tvrdá podmienka fázy 5**, nie poznámka. Zistiť stav v produkcii |
| R3 | Jej DID musí byť v allowliste cieľov | Krok postupu fázy 5 |
| R4 | Dĺžka hovoru je zaklampovaná na **300 s** (`config.ts:380`); 320 s je len rezerva funkcie | Strop hovoru s nástrojmi. AK 29 |
| R5 | Ticho po zdvihnutí (hop cez sieť) | Zmerať vo fáze 5; nad 8 s → zvážiť C |
| R6 | Prompt sa rozrastie | Test vzniká vo fáze 1 (§0) |
| R7 | **Tvar udalosti volania funkcie nie je overený** | Spike na začiatku fázy 2 (§5.1). Pri neúspechu padá zápis v hovore |
| R8 | Hovor na jej DID môže vytvoriť dispečerskú reláciu | §9.1; AK 27 |
| R9 | Pri hovore cez skupinu je `from` naša linka, nie zákazník | §4.1; bez toho nefunguje vyhľadanie ani SMS kontrola |
| R10 | Na vetve opakovaného ponúkania z fronty sa k nej hovor nedostane (`transitions.ts:1050`) | Známe obmedzenie, §2 |
| R11 | Prepínač plného odomknutia zapnutý po importe reálnych dát | Podmienka pri každom importe; AK 30 |

---

## 14. Testy

| Vrstva | Čo |
|---|---|
| Jednotkové | Tvar nástrojov (AK 6), normalizácia EČV, podmienky SMS (AK 21–24), dĺžka promptu (P2), vylúčenie z výpisov (AK 5) |
| Integračné | Vykonávač proti `fake-supabase`: vypršanie, zamietnutie, mŕtvy socket (AK 17), súbeh; zápis do `motorist_ai_tool_calls` v každej vetve; `materialiseRingPlan` s ňou aj bez nej (AK 3, 28) |
| Izolačné | AK 25–28: porovnanie postupnosti efektov s ignorovaním UUID a časov, päť brán × dve čísla |
| E2E | Potvrdenie návrhu dispečerom (AK 19); panel nastavení na 390 a 1440 px |
| Migračné | DDL proti reálnemu PostgreSQL ako `tests/postgres/ai-demo-attempts.sh` |
| Pozorovateľnosť | AK 12 nad zachytenými logmi; meranie AK 13–16 zvlášť pre hovory s nástrojmi a bez nich |
| Živé | Fáza 2: tri hovory s čítaním, **výhradne nad vyrobenými prípadmi**, nie nad existujúcimi záznamami. Fáza 5: jeden prichádzajúci cez ring + jeden na iné číslo v tej istej relácii |

---

## 15. ADR

**Rozhodnutie.** AI dostane profil bez prihlásenia (`kind='ai'`); do ring plánu sa dostane **existujúcim** mechanizmom dosiahnuteľnosti na čísle, bez zmeny v `ring-plan.ts`; prípad volajúceho sa načíta pri prijatí, nástroje riešia zvyšok a bežia v existujúcom listeneri; oprávnenia sa odvodzujú od toho, kto je na linke; hranice sú v kóde.

**Drivery.** Ochrana údajov; latencia; veľkosť zásahu do zvonenia.

**Zvážené alternatívy.** Ring: nový `delivery_mode` (~10 súborov vrátane horúcej cesty), priamy SIP (zásah do vytáčania), nový `member_kind`. Nástroje: druhý listener (zakázané), všetko po hovore (jadro prebraté ako predbežné načítanie).

**Prečo takto.** Každé rozšírenie ide tam, kde na to už miesto je: dosiahnuteľnosť na čísle, `motorist_audit_log`, `default_from_line_id`, hlásenia. Nevzniká druhá cesta k ničomu. Kde plán v prvej verzii tvrdil viac, než kód dovoľoval, je to v §0 vypísané.

**Dôsledky.** Hop cez sieť pri zvonení (cena a ticho). Hovor ohraničený na 300 s. Jeden hovor naraz. Fáza 5 sa dotkne prichádzajúcej cesty — preto preformulované P3. Na vetve opakovaného ponúkania z fronty sa k nej hovor nedostane (§2). Plné odomknutie údajov visí na prepínači, ktorý treba vypnúť pri prvom importe reálnych dát (§4).

**Follow-ups.** Číslo prípadu ako kontrola, ktorá odomkne citlivé údaje v produkcii (§4) — bez nej zostávajú v produkcii zamknuté. Možnosť C po zmeraní R5. Naliehavé hovory. Editovanie prípadov.

---

## 16. Rozhodnutia majiteľa (2026-09-20)

| # | Otázka | Rozhodnutie |
|---|---|---|
| A | EČV ako jediná kontrola, alebo číslo prípadu pre citlivé údaje? | **EČV odomyká všetko v `development`** (test a dev — uzavretý okruh volajúcich, bezpečné). V `production` odomyká stav a termín; citlivý stĺpec čaká na kontrolu cez číslo prípadu. Rozsah riadi stĺpec `environment`, nie dohoda — §4 |
| B | Prijímaš, že fáza 5 sa dotkne prichádzajúcej cesty (§9.1)? | **Prijaté (2026-09-20).** Fáza 5 smie pridať odbočku podľa cieľového čísla pred `createInboundSession`, za podmienky AK 25–28 |

Obe otázky sú uzavreté. Plán nemá ďalšie blokujúce neznáme; zostávajú riziká R1–R8, ktoré sa riešia v priebehu fáz.


---

## 17. Záznam konsenzu

| Kolo | Architect | Critic | Čo z toho vzišlo |
|---|---|---|---|
| 1 | Falošné „nula zmien v ring pláne"; SMS príjemca; 44 miest čítajúcich profily | `ITERATE` — neexistujúci test promptu, EČV ako verejný údaj, neoveriteľné kritériá | Voľba ring mechanizmu sa obrátila na A; bezpečnosť prepracovaná; odhad 8 → 11 dní |
| 2 | Rozbité číslo volajúceho pri hovore cez skupinu; predbežné načítanie nemá pri inbounde kde bežať; `environment` nie je bezpečnostná hranica | `ITERATE` — počítadlo kľúčované na údaj, ktorý útočník ovláda; AK 26/27 si odporujú; strop promptu aritmeticky nemožný | §4.1 (dohľadanie zákazníka cez reláciu); fail-closed prepínač; M5 kľúčované na prípad; AK prepísané; odhad 11 → 12 dní |

Nálezy oboch kôl som overil vlastnou kontrolou kódu; `transitions.ts:895`, `config.ts:380`, `transitions.ts:1050` a stav databázy sú zmerané, nie prevzaté.

**Zostáva otvorené a vedome:** hodnota AK 15 (až po spike), vynútenie prahov z pre-mortemu (dnes ručné), a obmedzenie z fronty (R10).


---

## 18. Revízia 4 — oprava vlastného nálezu

Kolo 1 aj kolo 2 tvrdili, že test na dĺžku promptu neexistuje. Overil som to greppom a potvrdil. **Bolo to nesprávne u všetkých troch.**

`prompts.test.ts` obsahoval na riadku 171 surový NUL bajt ako testovacie dáta pre `sanitizeContext`. `grep` súbor s NUL bajtom považuje za binárny a bez `-a` nevypíše nič — ani zhodu, ani chybu. Súbor bol teda pre každé hľadanie prázdny.

Test existuje od začiatku (`prompts.test.ts:22`) a prechádza spolu s ďalšími štyridsiatimi.

**Opravené:** surové riadiace bajty nahradené escape sekvenciami (`\u0000`, `\u001F`). Hodnota reťazca je rovnaká, test overuje to isté, a súbor je opäť viditeľný pre nástroje.

**Poučenie pre zvyšok plánu:** negatívny nález z greppu („toto nikde nie je") je dôkaz len vtedy, keď je istota, že súbor bol prečítaný. Ostatné negatívne nálezy v §0 sa týkajú súborov bez riadiacich bajtov — prekontrolované, jediný taký súbor v `src`, `supabase`, `tests` a `e2e` bol tento.
