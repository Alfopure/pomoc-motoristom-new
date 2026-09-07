# Nahrávanie, prepis a kontrola kvality

Aplikácia používa Telnyx na nahrávanie, súkromný Supabase Storage na zvuk, ElevenLabs Scribe v2 na prepis a OpenAI GPT-5.6-Luna cez Batch Responses API na zhrnutie a návrh hodnotenia. Žiadna z týchto AI služieb nebeží na Hetzneri. Spracovanie pokračuje po malých krokoch v existujúcom Vercel crone; nevzniká ďalší worker ani plánovač.

## Obsluha

1. V **Nastavenia → Telefonovanie → Nahrávanie a kvalita** vedúci nastaví účely, prevádzkovateľa, kontakt, informačný dokument a lehoty. Zapnutie vyžaduje potvrdenie nastavení aj overené technické zapojenie. Nahrávanie, prepis, zhrnutie a osobné hodnotenie majú samostatné prepínače.
2. V **Hlášky a jazyk** možno upraviť text, jazyk SK/CS/EN/DE a hlas, vypočuť náhľad a vygenerovať nový zvuk. Nahrávanie bez hodnotenia kvality používa vlastné oznámenie. Zmena textu sama nezapína nahrávanie.
3. Počas vlastného hovoru panel zobrazuje skutočný stav nahrávania. **Zastaviť nahrávanie** uplatní námietku; stav „zastavuje sa“ trvá až do potvrdenia. Prerušenie sa nesmie automaticky obnoviť po podržaní ani odovzdaní. Neistý výsledok sa nezobrazuje ako úspešné zastavenie.
4. Detail skončeného hovoru obsahuje úseky zvuku, časový prepis, doložené fakty, riešenie a ďalší krok. Kliknutie na výrok otvorí príslušný úsek; medzera nemá prehrateľný obsah. Časy reči, ticha a prekrytia sú odhady, nie samostatné kritériá kvality.
5. Vedúci skontroluje sedem kritérií, upraví dôkazy a závery a schváli verziu. Oprava prepisu mení iba text a vyžiada novú analýzu/kontrolu. Operátor vidí svoje schválené hodnotenie a môže požiadať o jeho kontrolu; nemá tým prístup k zvuku či prepisom ostatných.

Prevádzkovateľ podľa pokynu vlastníka je **ALFOPURE s.r.o., IČO 11698055**, kontakt **info@alfopure.tech**. Verejná stránka `/ochrana-hovorov` obsahuje informácie a aktuálne lehoty bez prihlásenia. Slovenské oznámenie o nahrávaní a kvalite trvá približne 11 sekúnd; dostupné sú aj samostatné oznamy bez hodnotenia kvality a české, anglické a nemecké verzie.

Ak vlastník poverí aktiváciou pri nasadení a jeho pokyn nepochádza z prihláseného účtu dispečingu, audit nesmie použiť cudzí profil vedúceho. Servisný zápis môže zaznamenať `config.owner_approval`: pôvod `owner_instruction`, trvalú referenciu pokynu, jeho SHA-256, kontaktný e-mail a odtlačok presnej politiky vypočítaný databázou. `approved_by` zostáva prázdne a audit uvádza zdroj `deployment`. Zmena účelu, lehoty, funkcií alebo ďalšej konfigurácie zneplatní odtlačok; bežné potvrdenie vedúcim nahradí tento pôvod jeho skutočným profilom. Ide o záznam prevádzkového pokynu, nie o osvedčenie právneho posúdenia. Verejný endpoint ani nové používateľské konto tým nevzniká.

## Skóre a jeho hranice

| Kritérium | Váha |
| --- | ---: |
| Pozdrav a predstavenie |10 |
| Zistenie potrebných údajov |20 |
| Pochopenie potreby |15 |
| Riešenie a ďalší postup |25 |
| Zrozumiteľná komunikácia |15 |
| Podržanie a odovzdanie |10 |
| Ukončenie |5 |

Splnené=1, čiastočne=0,5, nesplnené=0. Nepoužité kritérium sa odpočíta z menovateľa; neznáme sa neprepočítava na nulu. Číselné skóre vyžaduje overeného operátora, úplný relevantný rozhovor, aspoň80% pokrytie a doložené zistenie údajov/pochopenie/ďalší postup. Chýbajúci začiatok nie je dôkaz chýbajúceho pozdravu. Automat ani iný účastník sa nepočíta operátorovi.

Do trendov vstupuje jedna aktuálna ľudská kontrola na hovor, operátora a verziu rubriky. Nový návrh neprepíše schválenú kontrolu. Zmena zdroja ju zneplatní. Pri menej než10 hodnotiteľných schválených hovoroch sa priemer ani poradie nezobrazuje. Výstup je pomôcka vedúcemu; nejde o kalibrovaný automat na pracovnoprávne rozhodnutia. Samostatná nezávisle anotovaná kalibrácia z implementačného plánu ešte neprebehla. Nepoužíva sa odhad emócií, osobnosti, zdravia ani prízvuku.

## Technické zapojenie

- Webhook Telnyx overuje Ed25519 podpis a vlastnú aplikáciu. Oznámenie musí dohrať pred začiatkom nahrávania. Každý zákaznícky segment má oddelený požadovaný a pozorovaný stav; súkromná konzultácia/whisper nesmie prekročiť bariéru nepotvrdeného zastavenia.
- Identita záznamu pochádza z potvrdenia `record_start`. Telnyx pri neskoršom `recording.saved` môže poslať už zmenený `client_state`; samotný stav poslednej hlášky preto nie je identifikátorom záznamu. Pred pripojením hlasu aplikácia ponechá 600 ms na rozbeh nahrávania a znova overí verziu hovoru. Čakajúce pripojenie sa uchová pre obnovu po páde procesu.
- `RECORDING_PROCESSING_ENABLED` je hlavný prepínač. `TELNYX_RECORDING_ENABLED` a `TELNYX_RECORDING_CONTRACT_VERIFIED` povoľujú odskúšaný základ; `TELNYX_RECORDING_CHANNELS_VERIFIED`, `TELNYX_RECORDING_TRANSFER_VERIFIED` a `TELNYX_RECORDING_CONFERENCE_VERIFIED` označujú samostatne doložené schopnosti. Test jednej topológie nie je potvrdenie ostatných.
- `TRANSCRIPTS_ENABLED` vyžaduje `ELEVENLABS_API_KEY`, `ELEVENLABS_SCRIBE_WEBHOOK_ID` a `ELEVENLABS_SCRIBE_WEBHOOK_SECRET`. Spätná adresa je `/api/telephony/webhooks/scribe`; HMAC podpis a päťminútové časové okno sa overia pred databázou. `webhook_id` je vždy explicitný, aby sa záznam neposielal iným odberateľom účtu.
- Scribe pri asynchrónnom stereo prepise používa `multichannel_output_style=separate`. Aplikácia zoradí slová oboch kanálov časovo a identitu priradí iba podľa vlastného potvrdeného účastníka. Automatické rozpoznanie jazyka môže zameniť blízke jazyky, najmä slovenčinu a češtinu; normalizácia kódu toto rozpoznanie nepredstiera ako opravené. Potvrdené odmietnutie požiadavky nevytvorilo prepis a nepotrebuje jeho vymazanie; pri neznámom výsledku sa odstránenie naďalej musí zosúladiť s poskytovateľom.
- `AI_TRANSCRIPT_ENABLED`, `OPENAI_API_KEY` a `OPENAI_CALL_ANALYSIS_MODEL=gpt-5.6-luna` zapínajú schválenú analýzu. Podporovaná alternatíva je `gpt-5.6-terra`. Kľúče zostávajú serverové. GPT požiadavky používajú `store:false`, prísnu JSON schému, nízke reasoning a explicitnú cache.
- Jediný cron zostáva `*/5 * * * * → /api/telephony/cron`, chránený `CRON_SECRET`. Nové úlohy dostanú najviac15s a skončia najneskôr50s od začiatku60s cronu; prednosť majú živé hovory. Batch môže trvať do24h, prehľad ukazuje čakajúce spracovanie.
- Počiatočný strop je najviac10 nových nahrávaných hovorov za hodinu,30minút na segment a128MiB na súbor. Dlhší hovor sa rozdelí. Denná rezervácia plateného spracovania je predvolene10USD na organizáciu; nie je to garantovaný konečný účet za telekomunikácie či úložisko.
- Import používa6MiB obnoviteľné TUS časti, kontrolu SHA-256 a presne povolené verejné HTTPS hosty z `TELNYX_RECORDING_DOWNLOAD_HOSTS`. Zvuk sa prehráva cez autorizovaný Range proxy, najviac8MiB na požiadavku; URL poskytovateľa ani podpísané úložiskové URL sa nevracajú klientovi.
- Dĺžka zvuku sa meria z overenej PCM WAV štruktúry a veľkosti súboru. Rozdiel oproti presným časom poskytovateľa väčší než 100 ms zruší potvrdenie úplnosti a priradenia hlasov. Platný, ale skrátený zvuk zostane prehrateľný s upozornením a bez číselného hodnotenia operátora. Aplikácia neposúva časovú os odhadom.
- Úlohy majú prenájom s generačným tokenom, kontrolu verzie zdroja a deduplikáciu. Po strate potvrdenia plateného odoslania sa zisťuje existujúca úloha; opakovanie webhooku nevytvára ďalší platený Batch. Neistotu nemožno obísť tlačidlom retry.

## Uchovanie a odstránenie

Predvolené nastavenie je30dní pre zvuk/prepis a90dní pre kontrolu. Závislý obsah je neprístupný už pri obmedzení alebo uplynutí lehoty zdroja; dlhšia lehota kontroly neobchádza vymazaný prepis. Oprávnenia sa kontrolujú pri každom prehrávaní. Vedúci/admin má prístup k archívu; senior vyžaduje explicitné `audio_read` a na schválenie aj `quality_review` v `motorist_call_recording_access`.

Zmazanie zneprístupní obsah ihneď a ponechá trvalý záznam odstránenia, aby oneskorený webhook nič neobnovil. Cron odstraňuje súkromný zvuk, prepisy, históriu opráv, texty hodnotení a odvodené výsledky; upratuje aj súbory poskytovateľov. OpenAI vstup má48h expiráciu a pred spustením24h Batch aspoň25h zostávajúcej platnosti. Najprv sa čaká na terminálny stav Batch (prípadne sa zruší), potom sa mažú input/output/error Files. Batch nemá vymyslený delete endpoint. Neznáma identita objektu alebo nepotvrdené odstránenie zostáva viditeľnou nedokončenou úlohou. Zmluvné bezpečnostné logy poskytovateľa sa nevydávajú za fyzicky vymazané údaje.

## Nasadenie tejto kópie

Výhradne Supabase `ifpaeegaesdmljfkdvcn`, Vercel `pomoc-motoristom-new`, Frankfurt/fra1. Postup: pracovná vetva→Preview→PR do dev→kontrola dev aliasu→PR dev do main→kontrola produkcie. Produkčný alias je `https://pomoc-motoristom-new.vercel.app`; požadovaná vlastná doména sa použije po platnom DNS.

Dve samostatne preskúmané migrácie vytvoria zdrojové metadáta, súkromné úlohy a pravidlá, intervaly účastníkov, verzie prepisov, analýzy a kontroly s RLS/RPC. Pred ich aplikovaním platí výslovný súhlas podľa AGENTS.md. Nepoužívať plošné `db push --include-all`: existujúca história migrácie vehicle_lookup má iný identifikátor než súbor v repozitári. Aplikovať iba dve konkrétne nahrávacie migrácie na uvedený projekt; žiadna oprava cudzej histórie nie je súčasťou vydania.

Spätné vypnutie: vypnúť nové funkcie v politike a serverových prepínačoch; pri živom hovore použiť zastavenie a sledovať potvrdenie. Existujúci sweep zosúladí zvyšné aktívne nahrávanie. Deštruktívny rollback tabuliek nie je potrebný; úlohy odstraňovania musia zostať funkčné aj pri vypnutej AI.

## Overovanie

Jednotkové a databázové testy pokrývajú súbeh prenájmov, CAS kontrol, staré tokeny, námietku pred zápisom obmedzenia, oneskorené výsledky, opravy a vymazanie. Browser overuje prehrávanie/medzery, redakciu, formuláre a konflikty na mobile aj desktope. Syntetický skutočný GPT Batch prešiel vrátane ignorovania prompt injection a potvrdeného vymazania Files; jeden taký príklad nedokazuje kalibráciu hodnotenia.

Skutočné syntetické Telnyx hovory medzi izolovanými SIP účtami overili dva hlasové kanály, zastavenie/obnovu a neprítomnosť súkromných zvukových markerov pri dvojstrannom spojení a konferencii. Odhalili aj 40 ms súbor pri metadátovej dĺžke 3,875 s; kontrola importu ho správne označí ako neúplný. Dvanásť zachytených WAV súborov prešlo kontrolou štruktúry a skutočnej dĺžky. Prichádzajúci smer, trojstranná konferencia a úplná matica odovzdania/whisper vyžadujú vlastné dôkazy; ich prepínače zostávajú vypnuté. Výsledky aktuálneho vydania a nevyriešené podmienky patria do release/UltraQA záznamu; tento návod sám nepotvrdzuje zapnutie produkcie.

Primárne kontrakty: [Telnyx recording](https://developers.telnyx.com/api-reference/call-commands/start-recording-call), [Scribe async](https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/batch/webhooks), [OpenAI Batch](https://developers.openai.com/api/docs/guides/batch), [Supabase TUS](https://supabase.com/docs/guides/storage/uploads/resumable-uploads).
