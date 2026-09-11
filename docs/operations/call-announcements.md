# Hlášky a jazyk telefonovania

V **Nastavenia → Telefonovanie → Hlášky a jazyk** vyberte linku, jazyk a kategóriu. Upravte text, vytvorte hlasovú nahrávku, vypočujte náhľad a stlačte **Uložiť hlášky a jazyk**. Zmena používaných hlášok platí pre nové hovory. Náhľad ani generovanie nemenia živú konfiguráciu. Rozpracované texty sa pri prepínaní liniek, jazykov a kategórií zachovajú.

Pripravené sú slovenské, české, anglické a nemecké hlášky. Vybraný jazyk platí pre linku; systém neodhaduje jazyk podľa telefónnej predvoľby. Existujúce vlastné nahrávky a texty konkrétneho IVR menu majú prednosť. Pri zmene menu vždy zosúlaďte vyslovené čísla s jeho akciami. Samotná úprava textu nemení smerovanie hovoru.

Všetky používané hovorené hlášky majú jednotný prirodzený hlas Richard. Zapnutý úvod prichádzajúceho hovoru trvá menej než 3 sekundy. Počas podržania hrá tichá inštrumentálna slučka; čakáreň pripomína možnosť spätného volania medzi dlhšími blokmi hudby. Zapnutý úvod sa dokončí pred spustením menu, hudby alebo zvonenia operátorov. Výpadok média má hlasovú náhradu; ak nefunguje ani tá, hovor pokračuje bežným smerovaním bez privítania. Chyba úvodnej nahrávky sama neukončí zákaznícky hovor. Oznam pred nahrávaním má samostatnú kontrolu dokončenia: pri jeho výpadku hovor pokračuje bez spustenia záznamu.

## Úvodné hlášky podľa smeru hovoru

Každá linka má dva nezávislé prepínače, spoločné pre všetky jej jazyky:

| Prepínač | Predvolené nastavenie | Správanie |
| --- | --- | --- |
| Prichádzajúce hovory | Zapnuté | Privítanie a pri povolenom nahrávaní príslušný oznam pred záznamom. |
| Odchádzajúce hovory | Vypnuté | Bez úvodného predstavenia, oznamu o nahrávaní a automatického nahrávania. Platí aj pre spätné volania. |

**Vypnutie úvodných hlášok vypne aj automatické nahrávanie nových hovorov v príslušnom smere**, aj keď ho politika organizácie inak povoľuje. Zapnutie odchádzajúcich hlášok obnoví predstavenie služby a pri splnení podmienok nahrávania aj oznam pred záznamom. Samotné zapnutie úvodu nestačí na povolenie nahrávania.

Pri odchádzajúcom hovore bez úvodných hlášok sa najprv prijme vlastná WebRTC vetva operátora. Zákaznícka vetva sa potom vytáča s providerovým `bridge_on_answer`: Telnyx prepojí zvuk hneď pri prijatí zákazníkom bez čakania na úvod, spustenie automatického záznamu či následný príkaz na prepojenie zo servera aplikácie.

Tieto prepínače nemenia hlasové menu, hudbu počas podržania a čakania ani oznamy pri prepájaní a zmene účastníkov. Prichádzajúci hovor s vypnutým úvodom pokračuje priamo bežným smerovaním. Uložená voľba platí pre nové hovory; prebiehajúci hovor používa vlastnú verziu nastavení. Staršie konfigurácie bez `inboundStartAnnouncements` a `outboundStartAnnouncements` používajú uvedené predvolené hodnoty bez migrácie.

## Kompletná knižnica a stav použitia

Editor obsahuje **26 situácií v štyroch jazykoch**, spolu 104 MP3 s hovoreným oznamom a jednu hudbu. Pri každej hláške je viditeľný stav použitia. Kategórie držia najviac sedem hlášok na jednej obrazovke:

| Kategória | Počet | Stav |
| --- | --- | --- |
| Používané v hovoroch | 7 | Privítanie, mimo hodín, hlavné menu, ponuka a potvrdenie spätného volania, nedostupnosť, nesprávna voľba. Zapojené do existujúcich situácií hovoru. |
| Čakanie a návrat | 4 | Podržanie, pripomenutie pri čakaní, čakáreň s ponukou spätného volania a návrat sú zapojené. |
| Prepájanie a účastníci | 6 | Prepájanie, konzultácia, parkovanie a pripojenie/odchod účastníka sú zapojené; neúspešné prepájanie je pripravené. |
| Ďalšie situácie | 4 | Odchádzajúci úvod sa riadi prepínačom smeru a predvolene je vypnutý. Oznam mimo hodín bez callbacku je zapojený; nezachytená voľba a chyba uloženia callbacku sú pripravené. |
| Nahrávanie | 5 | Oznámenie pre vybavenie pomoci alebo kontrolu kvality, potvrdené vypnutie a obnovenie sú zapojené pod podmienkami politiky nahrávania; nedostupnosť je pripravená. |

Knižnica rozlišuje hlášky zapojené do stavov hovoru a pripravené alternatívy. Skutočný počet používaných hlášok závisí od prepínačov linky a zapnutých funkcií; aktuálny stav zobrazuje editor. Všetky možno upravovať, generovať, prehrávať a uložiť. **Úprava samotného textu alebo nahrávky nezapína nahrávanie, pripravenú alternatívu ani vypnutý úvod.** Zmenu prepínača úvodných hlášok treba uložiť spolu s konfiguráciou. Hudba počas čakania sa používa naďalej. Pri podržaní, prepájaní a zmene účastníkov aplikácia najprv dokončí príslušnú hlášku a potom vykoná akciu; pri výpadku reči pokračuje pomoc bez hlášky.

## Upozornenie na nahrávanie

Nahrávanie sa riadi samostatnou sekciou **Nahrávanie a kvalita**, schválenou politikou organizácie a serverovými prepínačmi. Automatické nahrávanie navyše vyžaduje zapnuté úvodné hlášky pre smer daného hovoru. Pred prvým záznamom sa musí úspešne dokončiť príslušný oznam; pri zapnutom odchádzajúcom úvode mu predchádza predstavenie služby. Záznam zákazníckeho hovoru začne pred pripojením operátora. Pri vypnutom úvode sa oznam ani automatický záznam nespustia. Súbor v editore ani jeho uloženie nahrávanie nezapína. Nastavenia mimo aplikácie, napríklad automatické nahrávanie u operátora, treba overiť osobitne.

Pri podržaní, parkovaní, konzultácii a zmene topológie sa čaká na potvrdené zastavenie všetkých záznamov. Nejasný výsledok ostáva viditeľný ako neistý stav a súkromná akcia sa nevykoná. Návrat môže založiť nový segment iba pri overenej podpore danej topológie. Námietka vypne ďalšie nahrávanie tohto hovoru, obmedzí prístup k existujúcim segmentom a zakáže automatické obnovenie. Voliteľné hlasové potvrdenie vypnutia zaznie iba po potvrdenom zastavení. Neistý výsledok sa nevydáva za vypnuté nahrávanie.

V kategórii **Nahrávanie** je samostatný prepínač **Hlášky o zmenách nahrávania**, predvolene vypnutý. Ovláda oznámenia „Nahrávanie je vypnuté“ a „Pokračujeme v nahrávaní“ pre všetky jazyky vybranej linky. Tento stavový prepínač nemení úvodný oznam pred povoleným záznamom; úvod aj automatické nahrávanie však možno vypnúť príslušným prepínačom smeru hovoru opísaným vyššie. Stav nahrávania zostáva viditeľný operátorovi a skutočné zastavenie či obnovenie sa riadi politikou nahrávania. Uložená voľba platí pre nové hovory; prebiehajúci hovor má vlastnú verziu nastavení. Staršie konfigurácie bez `recordingStatusAnnouncements` používajú vypnuté stavové hlášky bez migrácie. Texty, náhľady a vygenerované nahrávky zostávajú dostupné aj pri vypnutí.

`TELNYX_RECORDING_ENABLED`, `TELNYX_RECORDING_CONTRACT_VERIFIED` a `RECORDING_PROCESSING_ENABLED` sú základné serverové podmienky; konferencie, prepájanie a identita zvukových kanálov majú samostatné overovacie prepínače. Testy s náhradným poskytovateľom nedokazujú správanie živého Telnyxu. Pred zapnutím treba zdokumentovať kontrolovaný test skutočných médií na tejto kópii aplikácie.

Politika vyberá správny upraviteľný oznam: **Nahrávanie na vybavenie pomoci** pre samotné vybavenie pomoci, alebo **Nahrávanie a kontrola kvality** pri schválenom vyhodnocovaní kvality. Každý variant má vlastný text a nahrávku vo všetkých štyroch jazykoch.

Slovenský text pre nahrávanie a kontrolu kvality (6,5 sekundy, bez privítania):

> Naša spoločnosť hovor nahráva na vybavenie pomoci a kontrolu kvality. Informácie a námietky vybaví dispečer.

Verzia bez kontroly kvality vynecháva slová „a kontrolu kvality“. Oznam neobsahuje názov Alfopure ani dlhý výpočet spracovania. Úvod identifikuje službu Pomoc motoristom aj v angličtine a nemčine; úplné údaje o ALFOPURE s.r.o., prepisovaní, AI, právach a lehotách sú na verejnej stránke `/ochrana-hovorov` a dostupné cez dispečera. Kontakt je info@alfopure.tech. Dispečer musí vedieť vybaviť avizovaný prístup k záznamu a námietku; kontaktný e-mail je dostupný aj bez živého dispečera.

Neexistuje jedna univerzálna povinná veta. Ide o vrstvené informovanie v kontexte pomenovanej služby, dostupného dispečera a úplných podrobností. Samotné slovo „spoločnosť“ nenahrádza identifikáciu prevádzkovateľa ani právny základ nahrávania. Pokračovanie v hovore sa nevydáva za súhlas. [Usmernenia ÚOOÚ/WP29, body 36–40](https://dataprotection.gov.sk/files/metod-edpb/10_usmernenia_k_transparentnosti.pdf), [CNIL k informovaniu pri nahrávaní telefonátov](https://www.cnil.fr/fr/cnil-direct/question/enregistrement-ou-ecoute-des-conversations-telephoniques-faut-il-informer-ses).

## Prevádzka

- Zabalené MP3 sa prehrávajú bez ElevenLabs kľúča. `TELNYX_MEDIA_BASE_URL` musí smerovať na verejne dostupný adresár `/telephony` tohto nasadenia. Všetky aktuálne hovorené hlášky používajú nové cesty `announcements-v4/…`, aby sa nepoužil starý zvuk z cache. Hudba zachováva `announcements-v1/moh.mp3`; staršie zvukové URL zostávajú dostupné.
- Generovanie používa výhradne serverové `ELEVENLABS_API_KEY`, nikdy kľúč v prehliadači. Volá sa len pri kliknutí na generovanie, nie pri prichádzajúcom hovore. Model: `eleven_multilingual_v2`, predvolený prirodzený slovenský hlas Richard; dostupná je aj jemná slovenská Jolana a pôvodné hlasy Sarah/Daniel. Nový prejav používa stabilitu 0,4, rýchlosť 1,1 a vypnuté zvýraznenie hlasu; staré presety zostávajú platné pre už uložené zvuky. Vlastný text sa neprekladá automaticky.
- Nové MP3 sa ukladajú do verejného bucketu `motorist-telephony-prompts` v Supabase tejto kópie; bucket sa vytvorí pri prvom generovaní. Texty hlášok sú verejne počuteľné a nemajú obsahovať tajomstvá. Generovanie spotrebúva ElevenLabs kredit, aj keď sa návrh napokon neuloží.
- Konfigurácia je v `motorist_telephony_lines.metadata.announcements`; nepotrebuje databázovú migráciu. Súbežná úprava odmietne zastaranú verziu, nesúvisiace metadáta sa zachovajú. Zmeny sa auditujú. Živá konfigurácia sa pri zostavení a testoch nemení.
- Hlasové súbory sú nemenné, oddelené podľa organizácie a linky. Zmena textu alebo hlasu zneplatní predošlý náhľad. Ak vlastný text nemá vytvorenú nahrávku, aplikácia ho prečíta hlasovou syntézou Telnyx v zvolenom jazyku.
- Hudba má nižšiu hlasitosť než reč; zabalené súbory sú mono MP3 pri 24 alebo 44,1 kHz. Zdrojové texty a stav použitia: `src/lib/telephony/announcements.ts`. Kompletný `public/telephony/announcements-v4/manifest.json` obsahuje všetkých 105 aktuálnych súborov vrátane hudby a čakania v rade, presný text, dĺžku, hlas, stav a kontrolný súčet.

Zmena sa vydáva cez pracovnú vetvu → Vercel Preview → PR do `dev`. Produkčné vydanie zostáva samostatným PR `dev` → `main`. Hlášky samy nepotrebujú migráciu. Nahrávanie a jeho spracovanie používajú samostatné migrácie a povolený existujúci päťminútový cron; nenasadzuje sa ďalší worker, listener ani scheduler.
