# Hlášky a jazyk telefonovania

V **Nastavenia → Telefonovanie → Hlášky a jazyk** vyberte linku, jazyk a kategóriu. Upravte text, vytvorte hlasovú nahrávku, vypočujte náhľad a stlačte **Uložiť hlášky a jazyk**. Zmena používaných hlášok platí pre nové hovory. Náhľad ani generovanie nemenia živú konfiguráciu. Rozpracované texty sa pri prepínaní liniek, jazykov a kategórií zachovajú.

Pripravené sú slovenské, české, anglické a nemecké hlášky. Vybraný jazyk platí pre linku; systém neodhaduje jazyk podľa telefónnej predvoľby. Existujúce vlastné nahrávky a texty konkrétneho IVR menu majú prednosť. Pri zmene menu vždy zosúlaďte vyslovené čísla s jeho akciami. Samotná úprava textu nemení smerovanie hovoru.

Všetky používané hovorené hlášky majú jednotný prirodzený hlas Richard. Úvod trvá menej než 3 sekundy. Počas podržania hrá tichá inštrumentálna slučka; čakáreň pripomína možnosť spätného volania medzi dlhšími blokmi hudby. Úvod sa dokončí pred spustením menu, hudby alebo zvonenia operátorov. Výpadok média má hlasovú náhradu; ak nefunguje ani tá, hovor pokračuje bežným smerovaním bez privítania. Chyba úvodnej nahrávky sama neukončí zákaznícky hovor. Oznam pred nahrávaním má samostatnú kontrolu dokončenia: pri jeho výpadku hovor pokračuje bez spustenia záznamu.

## Kompletná knižnica a stav použitia

Editor obsahuje **26 situácií v štyroch jazykoch**, spolu 104 MP3 s hovoreným oznamom a jednu hudbu. Pri každej hláške je viditeľný stav použitia. Kategórie držia najviac sedem hlášok na jednej obrazovke:

| Kategória | Počet | Stav |
| --- | --- | --- |
| Používané v hovoroch | 7 | Privítanie, mimo hodín, hlavné menu, ponuka a potvrdenie spätného volania, nedostupnosť, nesprávna voľba. Zapojené do existujúcich situácií hovoru. |
| Čakanie a návrat | 4 | Podržanie, čakáreň s ponukou spätného volania a návrat sú zapojené; samostatné pripomenutie je pripravené. |
| Prepájanie a účastníci | 6 | Prepájanie, konzultácia, parkovanie a pripojenie/odchod účastníka sú zapojené; neúspešné prepájanie je pripravené. |
| Ďalšie situácie | 4 | Odchádzajúci úvod je zapojený; nezachytená voľba, mimo hodín bez callbacku a chyba uloženia callbacku sú pripravené. |
| Nahrávanie | 5 | Oznámenie pre vybavenie pomoci alebo kontrolu kvality, potvrdené vypnutie a obnovenie sú zapojené pod podmienkami politiky nahrávania; nedostupnosť je pripravená. |

Do stavov hovoru je zapojených 20 hlášok; šesť ďalších alternatív je pripravených. Všetky možno upravovať, generovať, prehrávať a uložiť. **Uloženie hlášky nezapína nahrávanie ani pripravenú alternatívu.** Hudba počas čakania sa používa naďalej. Pri podržaní, prepájaní a zmene účastníkov aplikácia najprv dokončí príslušnú hlášku a potom vykoná akciu; pri výpadku reči pokračuje pomoc bez hlášky.

## Upozornenie na nahrávanie

Nahrávanie sa riadi samostatnou sekciou **Nahrávanie a kvalita**, schválenou politikou organizácie a serverovými prepínačmi. Zapojená implementácia vyžaduje úspešne dokončený oznam pred prvým záznamom. Záznam zákazníckeho hovoru začne pred pripojením operátora; pri odchádzajúcom hovore sa zákazník najprv dozvie, kto volá. Súbor v editore ani jeho uloženie nahrávanie nezapína. Nastavenia mimo aplikácie, napríklad automatické nahrávanie u operátora, treba overiť osobitne.

Pri podržaní, parkovaní, konzultácii a zmene topológie sa čaká na potvrdené zastavenie všetkých záznamov. Nejasný výsledok ostáva viditeľný ako neistý stav a súkromná akcia sa nevykoná. Návrat môže založiť nový segment iba pri overenej podpore danej topológie. Námietka vypne ďalšie nahrávanie tohto hovoru, obmedzí prístup k existujúcim segmentom a zakáže automatické obnovenie. Potvrdenie vypnutia zaznie až po potvrdenom zastavení. Neistý výsledok sa nevydáva za vypnuté nahrávanie.

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
