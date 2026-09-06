# Hlášky a jazyk telefonovania

V **Nastavenia → Telefonovanie → Hlášky a jazyk** vyberte linku, jazyk a kategóriu. Upravte text, vytvorte hlasovú nahrávku, vypočujte náhľad a stlačte **Uložiť hlášky a jazyk**. Zmena používaných hlášok platí pre nové hovory. Náhľad ani generovanie nemenia živú konfiguráciu. Rozpracované texty sa pri prepínaní liniek, jazykov a kategórií zachovajú.

Pripravené sú slovenské, české, anglické a nemecké hlášky. Vybraný jazyk platí pre linku; systém neodhaduje jazyk podľa telefónnej predvoľby. Existujúce vlastné nahrávky a texty konkrétneho IVR menu majú prednosť. Pri zmene menu vždy zosúlaďte vyslovené čísla s jeho akciami. Samotná úprava textu nemení smerovanie hovoru.

Všetkých sedem pôvodných hovorených hlášok nahrádza jednotný, pokojný hlas. Úvod má približne 3 sekundy. Namiesto opakovanej vety každých osem sekúnd hrá pri čakaní tichá 22-sekundová inštrumentálna slučka. Úvod sa dokončí pred spustením menu, hudby alebo zvonenia operátorov. Výpadok média má hlasovú náhradu; ak nefunguje ani tá, hovor pokračuje bežným smerovaním bez privítania. Chyba úvodnej nahrávky sama neukončí zákaznícky hovor. Oznam pred nahrávaním má samostatnú kontrolu dokončenia: pri jeho výpadku hovor pokračuje bez spustenia záznamu.

## Kompletná knižnica a stav použitia

Editor obsahuje **25 situácií v štyroch jazykoch**, spolu 100 hlasových MP3 a jednu hudbu. Pri každej hláške je viditeľný stav použitia. Kategórie držia najviac sedem hlášok na jednej obrazovke:

| Kategória | Počet | Stav |
| --- | --- | --- |
| Používané v hovoroch | 7 | Privítanie, mimo hodín, hlavné menu, ponuka a potvrdenie spätného volania, nedostupnosť, nesprávna voľba. Zapojené do existujúcich situácií hovoru. |
| Čakanie a návrat | 3 | Podržanie a návrat sú zapojené; opakované pripomenutie je pripravené. |
| Prepájanie a účastníci | 6 | Prepájanie, konzultácia, parkovanie a pripojenie/odchod účastníka sú zapojené; neúspešné prepájanie je pripravené. |
| Ďalšie situácie | 4 | Odchádzajúci úvod je zapojený; nezachytená voľba, mimo hodín bez callbacku a chyba uloženia callbacku sú pripravené. |
| Nahrávanie | 5 | Oznámenie pre vybavenie pomoci alebo kontrolu kvality, potvrdené vypnutie a obnovenie sú zapojené pod podmienkami politiky nahrávania; nedostupnosť je pripravená. |

Do stavov hovoru je zapojených 19 hlášok; šesť ďalších alternatív je pripravených. Všetky možno upravovať, generovať, prehrávať a uložiť. **Uloženie hlášky nezapína nahrávanie ani pripravenú alternatívu.** Hudba počas čakania sa používa naďalej. Pri podržaní, prepájaní a zmene účastníkov aplikácia najprv dokončí príslušnú hlášku a potom vykoná akciu; pri výpadku reči pokračuje pomoc bez hlášky.

## Upozornenie na nahrávanie

Nahrávanie sa riadi samostatnou sekciou **Nahrávanie a kvalita**, schválenou politikou organizácie a serverovými prepínačmi. Zapojená implementácia vyžaduje úspešne dokončený oznam pred prvým záznamom. Záznam zákazníckeho hovoru začne pred pripojením operátora; pri odchádzajúcom hovore sa zákazník najprv dozvie, kto volá. Súbor v editore ani jeho uloženie nahrávanie nezapína. Nastavenia mimo aplikácie, napríklad automatické nahrávanie u operátora, treba overiť osobitne.

Pri podržaní, parkovaní, konzultácii a zmene topológie sa čaká na potvrdené zastavenie všetkých záznamov. Nejasný výsledok ostáva viditeľný ako neistý stav a súkromná akcia sa nevykoná. Návrat môže založiť nový segment iba pri overenej podpore danej topológie. Námietka vypne ďalšie nahrávanie tohto hovoru, obmedzí prístup k existujúcim segmentom a zakáže automatické obnovenie. Potvrdenie vypnutia zaznie až po potvrdenom zastavení. Neistý výsledok sa nevydáva za vypnuté nahrávanie.

`TELNYX_RECORDING_ENABLED`, `TELNYX_RECORDING_CONTRACT_VERIFIED` a `RECORDING_PROCESSING_ENABLED` sú základné serverové podmienky; konferencie, prepájanie a identita zvukových kanálov majú samostatné overovacie prepínače. Testy s náhradným poskytovateľom nedokazujú správanie živého Telnyxu. Pred zapnutím treba zdokumentovať kontrolovaný test skutočných médií na tejto kópii aplikácie.

Politika vyberá správny upraviteľný oznam: **Nahrávanie na vybavenie pomoci** pre samotné vybavenie pomoci, alebo **Nahrávanie a kontrola kvality** pri schválenom vyhodnocovaní kvality. Každý variant má vlastný text a nahrávku vo všetkých štyroch jazykoch.

Slovenský text pre nahrávanie a kontrolu kvality (12,7 sekundy, bez privítania):

> Hovor nahrávame a vyhodnocujeme na vybavenie pomoci a kontrolu kvality. Záznam spracúvajú naši poskytovatelia. Informácie, prístup k záznamu alebo námietku riešte s dispečerom.

Ide o návrh prvej vrstvy informácie. Účel a okruh príjemcov musia pred použitím zodpovedať skutočnému spracúvaniu. Samotná krátka hláška nezabezpečuje úplné splnenie informačnej povinnosti ani právny základ nahrávania.

[EDPB v odpovedi k nahrávaniu telefonátov](https://www.edpb.europa.eu/sme/find-practical-info/faq_en) uvádza informovanie o účele, príjemcoch, možnosti namietať a prístupe k záznamu. Samotné „hovor je nahrávaný“ preto nestačí. Neexistuje jedna univerzálna povinná veta ani predpísaný počet sekúnd.

[EDPB odporúča vrstvené informovanie](https://www.edpb.europa.eu/sme/be-compliant/respect-individuals-rights_en): stručný úvod doplnený dostupnými podrobnosťami. Pred reálnym nahrávaním musí prevádzkovateľ sprístupniť úplné informácie podľa čl. 13 GDPR, najmä svoju identitu a kontakt, skutočný účel a právny základ, príjemcov, uchovávanie a práva. Tento repozitár neobsahuje overené údaje potrebné na vyplnenie takého oznámenia. Dispečer musí vedieť vybaviť avizovaný prístup a námietku. Pre prípad bez dispečera musí byť k dispozícii ďalší dostupný spôsob získania informácií a uplatnenia práv.

[Nahrávanie potrebuje zodpovedajúci právny základ](https://www.edpb.europa.eu/sme/be-compliant/process-personal-data-lawfully_en). Pokračovanie v hovore sa tu nevydáva za súhlas. Implementácia čaká na dokončenie informácie pred zachytávaním. Prevádzkovateľ musí podľa zvoleného právneho základu zabezpečiť aj potrebné voľby volajúceho.

## Prevádzka

- Zabalené MP3 sa prehrávajú bez ElevenLabs kľúča. `TELNYX_MEDIA_BASE_URL` musí smerovať na verejne dostupný adresár `/telephony` tohto nasadenia. Sedem nezmenených hlášok a hudba zachovávajú cesty `announcements-v1/…`; nové hlášky a upravené oznámenie majú cesty `announcements-v2/…`, aby sa nepoužil starý zvuk z cache.
- Generovanie používa výhradne serverové `ELEVENLABS_API_KEY`, nikdy kľúč v prehliadači. Volá sa len pri kliknutí na generovanie, nie pri prichádzajúcom hovore. Model: `eleven_multilingual_v2`, hlas Sarah alebo Daniel. Vlastný text sa neprekladá automaticky.
- Nové MP3 sa ukladajú do verejného bucketu `motorist-telephony-prompts` v Supabase tejto kópie; bucket sa vytvorí pri prvom generovaní. Texty hlášok sú verejne počuteľné a nemajú obsahovať tajomstvá. Generovanie spotrebúva ElevenLabs kredit, aj keď sa návrh napokon neuloží.
- Konfigurácia je v `motorist_telephony_lines.metadata.announcements`; nepotrebuje databázovú migráciu. Súbežná úprava odmietne zastaranú verziu, nesúvisiace metadáta sa zachovajú. Zmeny sa auditujú. Živá konfigurácia sa pri zostavení a testoch nemení.
- Hlasové súbory sú nemenné, oddelené podľa organizácie a linky. Zmena textu alebo hlasu zneplatní predošlý náhľad. Ak vlastný text nemá vytvorenú nahrávku, aplikácia ho prečíta hlasovou syntézou Telnyx v zvolenom jazyku.
- Hudba má nižšiu hlasitosť než reč; zabalené súbory sú mono MP3 pri 24 alebo 44,1 kHz. Zdrojové texty a stav použitia: `src/lib/telephony/announcements.ts`. Kompletný `public/telephony/announcements-v2/manifest.json` obsahuje všetkých 101 súborov vrátane nezmenených v1 ciest, presný text, dĺžku, stav a kontrolný súčet.

Zmena sa vydáva cez pracovnú vetvu → Vercel Preview → PR do `dev`. Produkčné vydanie zostáva samostatným PR `dev` → `main`. Hlášky samy nepotrebujú migráciu. Nahrávanie a jeho spracovanie používajú samostatné migrácie a povolený existujúci päťminútový cron; nenasadzuje sa ďalší worker, listener ani scheduler.
