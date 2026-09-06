# Hlášky a jazyk telefonovania

V **Nastavenia → Telefonovanie → Hlášky a jazyk** vyberte linku, jazyk a kategóriu. Upravte text, vytvorte hlasovú nahrávku, vypočujte náhľad a stlačte **Uložiť hlášky a jazyk**. Zmena používaných hlášok platí pre nové hovory. Náhľad ani generovanie nemenia živú konfiguráciu. Rozpracované texty sa pri prepínaní liniek, jazykov a kategórií zachovajú.

Pripravené sú slovenské, české, anglické a nemecké hlášky. Vybraný jazyk platí pre linku; systém neodhaduje jazyk podľa telefónnej predvoľby. Existujúce vlastné nahrávky a texty konkrétneho IVR menu majú prednosť. Pri zmene menu vždy zosúlaďte vyslovené čísla s jeho akciami. Samotná úprava textu nemení smerovanie hovoru.

Všetkých sedem pôvodných hovorených hlášok nahrádza jednotný, pokojný hlas. Úvod má približne 3 sekundy. Namiesto opakovanej vety každých osem sekúnd hrá pri čakaní tichá 22-sekundová inštrumentálna slučka. Úvod sa dokončí pred spustením menu, hudby alebo zvonenia operátorov. Výpadok média má hlasovú náhradu; ak nefunguje ani tá, hovor pokračuje bežným smerovaním bez privítania. Chyba úvodnej nahrávky sama neukončí zákaznícky hovor. Toto pravidlo platí pre obyčajné privítanie; budúci oznam pred nahrávaním má samostatné podmienky.

## Kompletná knižnica a stav použitia

Editor obsahuje **24 situácií v štyroch jazykoch**, spolu 96 hlasových MP3 a jednu hudbu. Pri každej hláške je viditeľný stav použitia. Kategórie držia najviac sedem hlášok na jednej obrazovke:

| Kategória | Počet | Stav |
| --- | --- | --- |
| Používané v hovoroch | 7 | Privítanie, mimo hodín, hlavné menu, ponuka a potvrdenie spätného volania, nedostupnosť, nesprávna voľba. Zapojené do existujúcich situácií hovoru. |
| Čakanie a návrat | 3 | Podržanie, pripomenutie, návrat. Pripravené, neaktívne. |
| Prepájanie a účastníci | 6 | Začiatok/neúspech prepájania, konzultácia, parkovanie, pripojenie/odchod účastníka. Pripravené, neaktívne. |
| Ďalšie situácie | 4 | Odchádzajúci úvod, nezachytená voľba, mimo hodín bez callbacku, chyba uloženia callbacku. Pripravené, neaktívne. |
| Nahrávanie | 4 | Oznámenie, vypnutie, obnovenie, nedostupnosť. Pripravené, neaktívne. |

Pripravené hlášky možno upravovať, generovať, prehrávať a uložiť. **Uloženie nezapne ich prehrávanie v hovore ani nahrávanie.** Ich budúce zapojenie vyžaduje zodpovedajúcu implementáciu smerovania; tieto nastavenia neobsahujú vypínač, ktorý by ju predstieral. Existujúca hudba počas čakania sa naďalej používa.

## Upozornenie na nahrávanie

**Táto verzia aplikácie nahrávanie hovorov nespúšťa.** Hláška „Upozornenie na nahrávanie“ je pripravená na úpravu a vypočutie, ale automaticky sa neprehráva. Uloženie ani generovanie hlášky nahrávanie nezapína. Nastavenia mimo aplikácie, napríklad automatické nahrávanie u operátora, treba overiť osobitne pred jeho zapnutím.

Pripravený slovenský text (12,7 sekundy, bez privítania):

> Hovor nahrávame a vyhodnocujeme na vybavenie pomoci a kontrolu kvality. Záznam spracúvajú naši poskytovatelia. Informácie, prístup k záznamu alebo námietku riešte s dispečerom.

Ide o návrh prvej vrstvy informácie. Účel a okruh príjemcov musia pred použitím zodpovedať skutočnému spracúvaniu. Samotná krátka hláška nezabezpečuje úplné splnenie informačnej povinnosti ani právny základ nahrávania.

[EDPB v odpovedi k nahrávaniu telefonátov](https://www.edpb.europa.eu/sme/find-practical-info/faq_en) uvádza informovanie o účele, príjemcoch, možnosti namietať a prístupe k záznamu. Samotné „hovor je nahrávaný“ preto nestačí. Neexistuje jedna univerzálna povinná veta ani predpísaný počet sekúnd.

[EDPB odporúča vrstvené informovanie](https://www.edpb.europa.eu/sme/be-compliant/respect-individuals-rights_en): stručný úvod doplnený dostupnými podrobnosťami. Pred reálnym nahrávaním musí prevádzkovateľ sprístupniť úplné informácie podľa čl. 13 GDPR, najmä svoju identitu a kontakt, skutočný účel a právny základ, príjemcov, uchovávanie a práva. Tento repozitár neobsahuje overené údaje potrebné na vyplnenie takého oznámenia. Dispečer musí vedieť vybaviť avizovaný prístup a námietku. Pre prípad bez dispečera musí byť k dispozícii ďalší dostupný spôsob získania informácií a uplatnenia práv.

[Nahrávanie potrebuje zodpovedajúci právny základ](https://www.edpb.europa.eu/sme/be-compliant/process-personal-data-lawfully_en). Pokračovanie v hovore sa tu nevydáva za súhlas. Budúca implementácia musí začať zaznamenávať až po poskytnutí informácie a podľa zvoleného právneho základu zabezpečiť aj potrebné voľby volajúceho.

## Prevádzka

- Zabalené MP3 sa prehrávajú bez ElevenLabs kľúča. `TELNYX_MEDIA_BASE_URL` musí smerovať na verejne dostupný adresár `/telephony` tohto nasadenia. Sedem nezmenených hlášok a hudba zachovávajú cesty `announcements-v1/…`; nové hlášky a upravené oznámenie majú cesty `announcements-v2/…`, aby sa nepoužil starý zvuk z cache.
- Generovanie používa výhradne serverové `ELEVENLABS_API_KEY`, nikdy kľúč v prehliadači. Volá sa len pri kliknutí na generovanie, nie pri prichádzajúcom hovore. Model: `eleven_multilingual_v2`, hlas Sarah alebo Daniel. Vlastný text sa neprekladá automaticky.
- Nové MP3 sa ukladajú do verejného bucketu `motorist-telephony-prompts` v Supabase tejto kópie; bucket sa vytvorí pri prvom generovaní. Texty hlášok sú verejne počuteľné a nemajú obsahovať tajomstvá. Generovanie spotrebúva ElevenLabs kredit, aj keď sa návrh napokon neuloží.
- Konfigurácia je v `motorist_telephony_lines.metadata.announcements`; nepotrebuje databázovú migráciu. Súbežná úprava odmietne zastaranú verziu, nesúvisiace metadáta sa zachovajú. Zmeny sa auditujú. Živá konfigurácia sa pri zostavení a testoch nemení.
- Hlasové súbory sú nemenné, oddelené podľa organizácie a linky. Zmena textu alebo hlasu zneplatní predošlý náhľad. Ak vlastný text nemá vytvorenú nahrávku, aplikácia ho prečíta hlasovou syntézou Telnyx v zvolenom jazyku.
- Hudba má nižšiu hlasitosť než reč; zabalené súbory sú mono MP3 pri 24 alebo 44,1 kHz. Zdrojové texty a stav použitia: `src/lib/telephony/announcements.ts`. Kompletný `public/telephony/announcements-v2/manifest.json` obsahuje všetkých 97 súborov vrátane nezmenených v1 ciest, presný text, dĺžku, stav a kontrolný súčet.

Zmena sa vydáva cez pracovnú vetvu → Vercel Preview → PR do `dev`. Produkčné vydanie zostáva samostatným PR `dev` → `main`. Žiadny worker, listener, scheduler ani migrácia sa týmto nenasadzuje.
