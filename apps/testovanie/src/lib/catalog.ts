import type { Area, Scenario } from "./model";

export const catalogVersion = "2026-09-09.1";
export const areas: Area[] = [
  {
    id: "AUTH",
    name: "Prihlásenie a oprávnenia",
    short: "Prihlásenie",
    description: "Účty, relácie a prístup podľa roly.",
  },
  {
    id: "UI",
    name: "Pracovisko a ovládanie",
    short: "Pracovisko",
    description: "Navigácia, vyhľadávanie a rozpracované údaje.",
  },
  {
    id: "CASE",
    name: "Prípady a ukončenie",
    short: "Prípady",
    description: "Od založenia prípadu po uzavretie zásahu.",
  },
  {
    id: "TASK",
    name: "Úlohy a odovzdanie",
    short: "Úlohy",
    description: "Kto, čo a dokedy vybaví.",
  },
  {
    id: "NOT",
    name: "Upozornenia",
    short: "Upozornenia",
    description: "Správna správa správnemu človeku.",
  },
  {
    id: "CALL",
    name: "Hovory a pauzy",
    short: "Hovory",
    description: "Zvuk, čakáreň, prepojenia a dostupnosť.",
  },
  {
    id: "CB",
    name: "Callbacky a história",
    short: "Callbacky",
    description: "Žiadny zabudnutý ani duplicitný kontakt.",
  },
  {
    id: "SMS",
    name: "SMS a poloha",
    short: "SMS a poloha",
    description: "Správy, doručenie a poloha zákazníka.",
  },
  {
    id: "MAP",
    name: "Mapy a trasy",
    short: "Mapy",
    description: "Miesto zásahu, cieľ, vzdialenosť a ETA.",
  },
  {
    id: "VEH",
    name: "Údaje vozidla",
    short: "Údaje vozidla",
    description: "EČV, VIN a dohľadanie údajov.",
  },
  {
    id: "FLEET",
    name: "Flotila a kapacity",
    short: "Flotila",
    description: "Technika, náhradné vozidlá a obsadenosť.",
  },
  {
    id: "DIR",
    name: "Adresár a pobočky",
    short: "Adresár",
    description: "Firmy, asistencie, kontakty a pobočky.",
  },
  {
    id: "REC",
    name: "Nahrávky a kvalita",
    short: "Nahrávky",
    description: "Nahrávanie, prepisy a hodnotenie.",
  },
  {
    id: "ATT",
    name: "Dochádzka a smeny",
    short: "Dochádzka",
    description: "Pracovný čas, plánovanie a žiadosti.",
  },
  {
    id: "REP",
    name: "Reporty a wallboard",
    short: "Reporty",
    description: "Čísla, ktoré zodpovedajú skutočnosti.",
  },
  {
    id: "OPS",
    name: "Mobil, nastavenia a prevádzka",
    short: "Mobil a prevádzka",
    description: "Zariadenia, integrácie, databáza a výpadky.",
  },
];

const definitions: Scenario[] = [];
function scenario(
  area: string,
  level: 1 | 2,
  title: string,
  role: string,
  setup: string,
  steps: string[],
  expected: string,
  options: { internal?: boolean; cleanup?: string; source?: string } = {},
) {
  definitions.push({
    id: `${area}-${String(definitions.filter((s) => s.area === area).length + 1).padStart(2, "0")}`,
    area,
    level,
    title,
    role,
    setup,
    steps,
    expected,
    cleanup:
      options.cleanup ??
      "Ponechajte iba označené testovacie údaje a vráťte zmenené nastavenia do dohodnutého stavu.",
    audience: options.internal ? "internal" : "everyone",
    source:
      options.source ??
      "Plán testovania 9. 9. 2026 · aktuálny dev b02ee19 · požiadavky tímu",
  });
}

scenario(
  "AUTH",
  1,
  "Prihlásenie správnymi aj chybnými údajmi",
  "Dispečer",
  "Aktívny testovací účet. Dispečing je otvorený v odhlásenom prehliadači.",
  [
    "Zadajte nesprávne heslo a skúste vstúpiť.",
    "Opravte heslo a prihláste sa.",
    "Overte zobrazené meno a dostupné moduly.",
  ],
  "Chybné údaje neumožnia vstup a zobrazia zrozumiteľnú chybu. Správne údaje otvoria pracovisko správnej osoby.",
);
scenario(
  "AUTH",
  1,
  "Odhlásenie a návrat na chránenú stránku",
  "Dispečer",
  "Prihlásený testovací účet; zapamätajte si otvorenú adresu dispečingu.",
  [
    "Odhláste sa.",
    "Použite Späť, obnovte stránku a otvorte pôvodnú adresu.",
    "Overte, že bez nového prihlásenia nemožno čítať ani meniť pracovné údaje.",
  ],
  "Odhlásenie ukončí miestnu reláciu a chránené údaje nie sú dostupné. Testovacia evidencia v druhej karte ostane použiteľná.",
);
scenario(
  "AUTH",
  1,
  "Dispečer nemôže spravovať cudzie oprávnenia",
  "Dispečer + administrátor",
  "Dva účty s rozdielnymi rolami.",
  [
    "Ako administrátor nájdite správu používateľov.",
    "V inom profile prehliadača vstúpte ako dispečer.",
    "Pokúste sa otvoriť tú istú správu a zmeniť rolu.",
  ],
  "Dispečer nemôže zvýšiť svoje ani cudzie oprávnenia; odmietnutie je zrozumiteľné.",
);
scenario(
  "AUTH",
  2,
  "Pozvánka, prvé heslo a obnova hesla",
  "Administrátor + nový používateľ",
  "Určená testovacia e-mailová schránka.",
  [
    "Pozvite nový účet a otvorte prijatú pozvánku.",
    "Nastavte heslo, vstúpte a následne spustite obnovu hesla.",
    "Overte nové heslo a opakované použitie spotrebovaného alebo expirovaného odkazu.",
  ],
  "Pozvánka aj obnova vedú ku správnemu účtu; neplatný odkaz nepridelí prístup a umožní zrozumiteľné opakovanie.",
);
scenario(
  "AUTH",
  2,
  "Deaktivácia účtu a zmena roly",
  "Administrátor",
  "Testovací používateľ otvorený v druhom prehliadači; dohodnutá platnosť existujúcich relácií.",
  [
    "Zmeňte rolu používateľa a overte jeho dostupné akcie.",
    "Deaktivujte účet.",
    "Overte nový vstup aj chránenú akciu z pôvodnej relácie.",
  ],
  "Server rešpektuje aktuálne oprávnenia a deaktivovaný používateľ nemôže pokračovať v chránených akciách.",
);
scenario(
  "AUTH",
  2,
  "Relácie na dvoch zariadeniach",
  "Dispečer",
  "Rovnaký účet na PC a mobile; miestne odhlásenie je dohodnutý režim.",
  [
    "Prihláste sa na oboch zariadeniach.",
    "Odhláste PC a skontrolujte mobil.",
    "Prihláste na PC inú osobu a overte údaje aj upozornenia.",
  ],
  "Miestne odhlásenie má dohodnutý dosah; údaje, upozornenia ani meno predchádzajúcej osoby sa nezamenia s novou.",
);
scenario(
  "AUTH",
  2,
  "Oprávnenia priamo na API a oddelenie dát",
  "Vývojár",
  "Izolované testovacie účty/organizácie a matica prístupov; bez použitia pôvodnej produkcie.",
  [
    "Overte citlivé čítanie aj zápis bez relácie a s nízkou rolou.",
    "Použite identifikátor objektu iného testovacieho používateľa/organizácie.",
    "Skontrolujte správu účtov, nahrávky, prílohy a verejný lokalizačný odkaz.",
  ],
  "Prístup sa overuje na serveri pre konkrétny objekt. Cudzie údaje ani administrátorské akcie nie sú dostupné neoprávnenej osobe.",
  { internal: true },
);

scenario(
  "UI",
  1,
  "Nájsť prípad a prepnúť pracovné moduly",
  "Dispečer",
  "Aspoň tri označené prípady s rôznym stavom a zákazníkom.",
  [
    "Vyhľadajte prípad podľa známeho údaja a otvorte detail.",
    "Prepnite medzi nástenkou, prípadmi a úlohami.",
    "Použite filter a potom ho vymažte.",
  ],
  "Výsledky zodpovedajú zadaniu; detail patrí vybranému prípadu a návrat do zoznamu je zrozumiteľný.",
);
scenario(
  "UI",
  1,
  "Rozpísané údaje sa nestratia pri navigácii",
  "Dispečer",
  "Otvorený formulár prípadu alebo úlohy s neuloženou zmenou.",
  [
    "Skúste prepnúť modul alebo zavrieť formulár.",
    "Zvoľte pokračovanie v editácii a overte rozpracovaný text.",
    "Následne zmenu uložte alebo vedome zahoďte.",
  ],
  "Aplikácia zabráni nechcenej strate rozpracovaných údajov; zvolená akcia má pravdivý výsledok.",
);
scenario(
  "UI",
  2,
  "Panely, pripnutá navigácia a malé okno",
  "Dispečer",
  "Pracovné PC; pripravený otvorený detail prípadu.",
  [
    "Zmeňte šírku panelov a pripnite používané moduly.",
    "Zmenšite okno a otvorte menu i dialóg.",
    "Obnovte stránku a overte uložené preferencie.",
  ],
  "Dôležité ovládanie ostáva dosiahnuteľné; panely sa neprekrývajú a preferencie patria správnemu používateľovi.",
);
scenario(
  "UI",
  2,
  "Prázdny zoznam, veľa výsledkov a stránkovanie",
  "Dispečer",
  "Známy súbor prípadov presahujúci jednu stránku.",
  [
    "Vyhľadajte neexistujúci údaj.",
    "Vymažte hľadanie, zmeňte radenie a prejdite na ďalšiu stránku.",
    "Zmeňte filter z neskoršej stránky.",
  ],
  "Prázdny stav má vysvetlenie; záznamy sa nestrácajú ani neduplikujú a zmena filtra nezanechá neplatnú stránku.",
);
scenario(
  "UI",
  2,
  "Klávesnica, fokus a zväčšenie",
  "Dispečer",
  "PC s klávesnicou.",
  [
    "Prejdite formulár a dialóg klávesmi Tab, Shift+Tab a Enter.",
    "Zavrite dialóg a sledujte návrat fokusu.",
    "Nastavte zväčšenie na 200 % a skúste základné uloženie.",
  ],
  "Fokus je viditeľný, polia majú popisy a základný postup možno dokončiť bez myši aj pri zväčšení.",
);

scenario(
  "CASE",
  1,
  "Založenie a opätovné otvorenie prípadu",
  "Dispečer",
  "Syntetický zákazník QA a určené testovacie telefónne číslo.",
  [
    "Ručne založte prípad, vyplňte zákazníka, službu a miesto incidentu.",
    "Uložte ho a poznačte si identifikátor.",
    "Obnovte stránku a dohľadajte rovnaký prípad.",
  ],
  "Vznikne práve jeden prípad s uloženými údajmi, správnym operátorom a dohľadateľným identifikátorom.",
);
scenario(
  "CASE",
  1,
  "Editácia prípadu, poznámka a uzavretie",
  "Dispečer",
  "Testovací prípad, ktorý možno uzavrieť.",
  [
    "Zmeňte kontakt alebo miesto a pridajte poznámku.",
    "Zmeňte zodpovedného operátora a stav podľa pracovného postupu.",
    "Uzavrite zásah a otvorte jeho históriu.",
  ],
  "Úpravy, zodpovednosť a výsledný stav sú uložené; história vysvetľuje vykonané zmeny a prípad ostáva dohľadateľný.",
);
scenario(
  "CASE",
  1,
  "Hovor → prípad → kolega → dokončenie",
  "Dvaja dispečeri + volajúci",
  "Testovacia linka a kapacita; koordinovaný čas hovoru.",
  [
    "Prijmite hovor a založte z neho prípad so správnym kontaktom.",
    "Doplňte zásah a priraďte kolegovi úlohu; kolega otvorí upozornenie.",
    "Dokončite úlohu aj prípad a skontrolujte komunikáciu v histórii.",
  ],
  "Celý pracovný postup je prepojený so správnym prípadom; nevzniká duplicitný prípad ani stratená úloha.",
);
scenario(
  "CASE",
  2,
  "Typy zákazníkov, služieb a kontaktné roly",
  "Dispečer",
  "Samoplatca, asistencia a firma; potrebné kontakty sú syntetické.",
  [
    "Prejdite údaje jednotlivých typov zákazníka a dostupných služieb.",
    "Pridajte odlišného vodiča, vlastníka a fakturačný kontakt.",
    "Uložte a použite kontakt pri hovore alebo náhľade SMS.",
  ],
  "Relevantné polia a povinnosti zodpovedajú typu prípadu; osoba, firma a fakturačný kontakt sa nezamenia.",
);
scenario(
  "CASE",
  2,
  "Neúplné údaje a chybný vstup",
  "Dispečer",
  "Nový testovací prípad.",
  [
    "Skúste uložiť bez povinných údajov.",
    "Zadajte neplatné číslo alebo nesúvisiace vozidlové údaje tam, kde sa validujú.",
    "Opravte vstup a znovu uložte.",
  ],
  "Chyby označia konkrétne polia, zachovajú platné rozpracované údaje a po oprave vznikne iba jeden prípad.",
);
scenario(
  "CASE",
  2,
  "Dva operátori upravujú rovnaký prípad",
  "Dvaja dispečeri",
  "Rovnaký prípad otvorený súčasne v dvoch účtoch.",
  [
    "Obaja zmeňte rovnaký údaj z pôvodnej hodnoty.",
    "Prvý operátor uloží, potom uloží druhý.",
    "Obnovte prípad a overte výsledok aj upozornenie druhému operátorovi.",
  ],
  "Novšia uložená zmena sa ticho nestratí. Konflikt alebo dohodnuté zlúčenie je zrozumiteľné a rozpracované údaje sa zachovajú.",
);
scenario(
  "CASE",
  2,
  "Zrušenie, odmietnutie a márny výjazd",
  "Dispečer",
  "Samostatný testovací prípad pre každý výsledok.",
  [
    "Nastavte zrušený, odmietnutý a márny výjazd v príslušných prípadoch.",
    "Doplňte dôvody a potrebné údaje uzavretia.",
    "Overte filtre, históriu a súvisiace úlohy/kapacity.",
  ],
  "Výsledky sa rozlišujú a nepočítajú sa ako úspešne poskytnutá pomoc; súvisiaca práca má dohodnutý stav.",
);
scenario(
  "CASE",
  2,
  "Prílohy a história údajov",
  "Dispečer",
  "Malý testovací obrázok a súbor nepovoleného typu, ak sa typy obmedzujú.",
  [
    "Pridajte podporovanú prílohu k správnemu prípadu.",
    "Obnovte detail a prílohu otvorte.",
    "Overte odmietnutý súbor alebo chybu nahrávania.",
  ],
  "Príloha je čitateľná iba v správnom kontexte; neúspešné nahratie sa netvári ako uložené a nezmaže formulár.",
);
scenario(
  "CASE",
  2,
  "Platobná evidencia, fakturácia a PDF",
  "Dispečer + manažér",
  "Pred skúškou zapíšte do podmienok kola, či vydanie vyžaduje reálny PDF dokument alebo iba podklad.",
  [
    "Vyplňte dohodnutý spôsob a stav platby.",
    "Vyžiadajte fakturačný podklad a overte súvisiacu úlohu.",
    "Spustite PDF akciu a porovnajte výstup s dohodnutým rozsahom.",
  ],
  "Platobná evidencia je správna. Požadovaný dokument musí skutočne vzniknúť; dnešný zápis o neskoršom exporte sám neznamená vygenerované PDF.",
);

scenario(
  "TASK",
  1,
  "Úloha pri prípade aj samostatná úloha",
  "Dvaja dispečeri",
  "Testovací prípad a konto kolegu.",
  [
    "Vytvorte úlohu pri prípade s termínom a riešiteľom.",
    "Vytvorte druhú úlohu bez prípadu.",
    "Ako kolega otvorte vlastné úlohy a prvú dokončite.",
  ],
  "Úlohy majú správne väzby a riešiteľa; dokončenie sa zobrazí obom osobám a neuzavrie nesúvisiacu úlohu.",
);
scenario(
  "TASK",
  1,
  "Úprava existujúcej úlohy",
  "Dispečer",
  "Otvorená testovacia úloha.",
  [
    "Upravte názov, termín, prioritu a poznámku.",
    "Zmeňte riešiteľa a uložte.",
    "Obnovte stránku a dohľadajte úlohu u nového riešiteľa.",
  ],
  "Editácia zmení pôvodnú úlohu bez vytvorenia kópie; nový riešiteľ vidí aktuálne údaje.",
);
scenario(
  "TASK",
  2,
  "Úlohy dnes, po termíne a odovzdanie",
  "Dvaja dispečeri",
  "Úlohy s dnešným, minulým a budúcim termínom.",
  [
    "Prejdite pohľady tím, dnes, po termíne, odovzdanie a hotové.",
    "Použite vlastné/tímové filtre a stránkovanie.",
    "Odovzdajte úlohu kolegovi a overte jej nový kontext.",
  ],
  "Každá úloha patrí do správneho pohľadu; termíny a odovzdanie nestratia riešiteľa ani históriu.",
);
scenario(
  "TASK",
  2,
  "Zmazanie, opätovné otvorenie a súbeh úloh",
  "Dvaja dispečeri",
  "Testovacie úlohy, ktoré možno zmazať alebo vrátiť do práce.",
  [
    "Zrušte dialóg zmazania a potom zmažte určenú úlohu.",
    "Vráťte dokončenú úlohu do otvoreného stavu, ak to pracovný postup povoľuje.",
    "Skúste súčasnú úpravu jednej úlohy dvoma operátormi.",
  ],
  "Zrušenie dialógu nič nezmaže; potvrdené zmazanie a zmena stavu upravia súvisiace upozornenia. Súbeh nestratí zmenu bez upozornenia.",
);

scenario(
  "NOT",
  1,
  "Upozornenie príde správnemu kolegovi",
  "Dvaja dispečeri",
  "Zapnuté upozornenia na úlohy; dve rôzne kontá.",
  [
    "Priraďte kolegovi úlohu s jednoznačným názvom.",
    "Overte upozornenie v jeho centre.",
    "Otvorte upozornenie a označte ho ako prečítané.",
  ],
  "Upozornenie vedie na správnu úlohu/prípad a stav prečítania sa uloží; súkromný obsah nevidí neoprávnená osoba.",
);
scenario(
  "NOT",
  1,
  "Push upozornenie na fyzickom mobile",
  "Dispečer + kolega",
  "Dohodnutý podporovaný mobil/PWA; systémové povolenie udelené.",
  [
    "Zapnite požadovanú kategóriu push na mobile.",
    "Nechajte kolegu vyvolať testovaciu udalosť, keď aplikácia nie je v popredí.",
    "Klepnite na upozornenie.",
  ],
  "Push sa doručí v podporovanom režime a otvorí správny obsah pod správnym účtom.",
);
scenario(
  "NOT",
  2,
  "Odloženie, pripomienka a archív",
  "Dispečer",
  "Testovacia úloha s krátkym dohodnutým termínom.",
  [
    "Odložte upozornenie a nájdite ho medzi odloženými.",
    "Počkajte na určený čas pripomienky.",
    "Archivujte ho a skontrolujte minulé upozornenia.",
  ],
  "Odloženie a archív menia iba určené upozornenie; pripomienka príde v správnom čase bez neprimeraných duplikátov.",
);
scenario(
  "NOT",
  2,
  "Povolenia, kategórie a zmena účtu",
  "Dispečer",
  "Dve zariadenia a druhý testovací účet.",
  [
    "Na jednom zariadení vypnite kategóriu upozornení alebo zamietnite systémové povolenie.",
    "Vyvolajte príslušnú udalosť a porovnajte druhé zariadenie.",
    "Odhláste sa a vstúpte ako iná osoba.",
  ],
  "Nastavenia zariadení majú dohodnutý dosah; zamietnutie má vysvetlenie a nový účet nedostáva súkromné upozornenia predchádzajúceho.",
);
scenario(
  "NOT",
  2,
  "Upozornenie počas rozpracovanej editácie",
  "Dispečer + kolega",
  "Neuložená zmena prípadu a pripravené upozornenie na inú úlohu.",
  [
    "Kliknite na upozornenie počas editácie.",
    "Odmietnite opustenie a overte rozpísaný text.",
    "Uložte a otvorte upozornenie znova.",
  ],
  "Prechod rešpektuje rozpracované údaje a potom otvorí správny cieľ.",
);

scenario(
  "CALL",
  1,
  "Prichádzajúci aj odchádzajúci hovor",
  "Dispečer + volajúci",
  "Povolené reálne testovacie hovory, mikrofón a určené čísla. Bez volania zákazníkom.",
  [
    "Zavolajte na testovaciu linku a prijmite hovor.",
    "Obaja potvrďte zvuk v oboch smeroch a hovor ukončite.",
    "Uskutočnite odchádzajúci hovor a ukončite ho z druhej strany.",
  ],
  "Zvuk funguje v oboch smeroch; oba spôsoby ukončenia uvoľnia ovládanie aj čakáreň a história má pravdivý výsledok.",
  { source: "QA-01 · zápisky 4. 9. · telephony-stability-rollout" },
);
scenario(
  "CALL",
  1,
  "Pauza počas zvonenia aj ako posledný operátor",
  "Dvaja dispečeri + volajúci",
  "Dohodnutá trasa pri nulovej dostupnosti; testovací hovor zvoní prvému operátorovi.",
  [
    "Počas zvonenia zapnite pauzu a skontrolujte zvuk aj dostupnosť.",
    "Zopakujte stav, keď sú ostatní operátori offline.",
    "Nechajte prísť ďalší hovor počas pauzy.",
  ],
  "Pauza zastaví automatické zvonenie; operátor sa nepočíta ako pripravený ani ako posledný online. Nový hovor ide do dohodnutej čakárne/zálohy a pauzu automaticky nezruší.",
  { source: "PA · PU · QA-03 · výslovná dohoda o pauze" },
);
scenario(
  "CALL",
  1,
  "Vedomé prevzatie hovoru počas pauzy",
  "Dispečer + volajúci",
  "Operátor je na pauze; čakajúci hovor je viditeľný a rozšírený tok je zapnutý.",
  [
    "Overte, že hovor na pauze sám nezvoní.",
    "Ručne a výslovne prevezmite konkrétny hovor z čakárne.",
    "Ukončite hovor a nechajte prísť ďalší.",
  ],
  "Ručné prevzatie umožní obsluhu jedného hovoru. Po ukončení sa obnoví pauza a ďalší hovor nezačne automaticky zvoniť.",
  { source: "PU · QA-03 · telephony-stability-rollout" },
);
scenario(
  "CALL",
  2,
  "Podržanie a parkovanie hovoru",
  "Dvaja dispečeri + volajúci",
  "Aktívny testovací hovor.",
  [
    "Podržte a obnovte hovor; overte zvuk u volajúceho.",
    "Zaparkujte hovor a prevezmite ho určeným operátorom.",
    "Nechajte volajúceho ukončiť aj počas čakania.",
  ],
  "Stavy aj hudba/oznámenie zodpovedajú situácii; hovor možno obnoviť a ukončený hovor nezostane visieť.",
);
scenario(
  "CALL",
  2,
  "Priame a dohodnuté prepojenie",
  "Dvaja dispečeri + volajúci",
  "Zapnutý podporovaný spôsob prepojenia; obaja operátori pripravení.",
  [
    "Prepojte jeden testovací hovor priamo na kolegu.",
    "Pri druhom najprv konzultujte a potom potvrďte prepojenie.",
    "Overte zvuk, vlastníka, čakáreň a ukončenie u všetkých strán.",
  ],
  "Hovor má správneho operátora; pôvodný operátor ani čakáreň nezostanú v nepravdivom aktívnom stave.",
  { source: "QA-02 · RC · zápisky 4. 9." },
);
scenario(
  "CALL",
  2,
  "Zrušená alebo neprijatá konzultácia",
  "Dvaja dispečeri + volajúci",
  "Aktívny hovor; cieľ konzultácie raz neodpovie a raz ju prijme.",
  [
    "Spustite konzultáciu bez odpovede a zrušte ju.",
    "Overte návrat k pôvodnému volajúcemu.",
    "Zopakujte s prijatou konzultáciou, ktorú ukončíte bez prepojenia.",
  ],
  "Pôvodný hovor sa nestratí, súkromná konzultácia sa nezamení s rozhovorom so zákazníkom a ovládanie zodpovedá stavu.",
);
scenario(
  "CALL",
  2,
  "Interný hovor, konferencia a účastníci",
  "Traja účastníci",
  "Podporované interné hovory a konferencia sú zapnuté.",
  [
    "Uskutočnite interný hovor medzi operátormi.",
    "V samostatnej skúške pridajte účastníka do konferencie a overte zvuk.",
    "Stlmte, odoberte alebo nechajte odísť účastníka a ukončite zvyšný hovor.",
  ],
  "Zoznam účastníkov a zvuk sa zhodujú; odchod jednej osoby nespôsobí nepravdivý stav ostatných.",
);
scenario(
  "CALL",
  2,
  "Výpadok siete, mikrofón a obnovenie",
  "Dispečer + volajúci",
  "Koordinovaný test na vlastnom zariadení; neodpájajte spoločnú infraštruktúru.",
  [
    "Overte odmietnuté povolenie mikrofónu.",
    "Po udelení povolenia počas hovoru krátko odpojte sieť vlastného zariadenia.",
    "Obnovte sieť, ukončite hovor a skúste ďalší.",
  ],
  "Chyba sa zobrazí pravdivo; ukončenie sa zosúladí po obnove a ovládanie nezostane trvalo zablokované.",
  { source: "QA-01 · RC · recovery" },
);
scenario(
  "CALL",
  2,
  "Štyri hovory a mobilná záloha",
  "Dvaja dispečeri + štyria volajúci",
  "Koordinované testovacie čísla, známy plán smerovania; vlastný mobil a nezávislá záloha rozlíšené.",
  [
    "Vyvolajte štyri súčasné hovory a zaznamenajte ich priebeh.",
    "Zmeňte dostupnosť podľa dohodnutého plánu vrátane pauzy vlastníka mobilu.",
    "Vybavte/ukončite všetky hovory a skontrolujte čakáreň.",
  ],
  "Žiadny hovor sa nestratí ani nezostane visieť; záloha dodrží pravidlá a pauza vlastníka nespustí jeho automatické zvonenie.",
  { source: "QA-05 · zápisky 4. 9." },
);

scenario(
  "CB",
  1,
  "Zmeškaný hovor a úspešný spätný kontakt",
  "Dispečer + volajúci",
  "Určené číslo; nový zmeškaný hovor v testovacej linke.",
  [
    "Nechajte hovor skončiť bez vybavenia.",
    "Nájdite callback a zavolajte späť so skutočne spojeným rozhovorom.",
    "Overte callback v čakárni aj úlohách/histórii.",
  ],
  "Vznikne dohľadateľná požiadavka; úspešný kontakt ju vybaví bez duplicitnej otvorenej úlohy.",
  { source: "CB · QA-04" },
);
scenario(
  "CB",
  1,
  "Nové zmeškanie po už vybavenom callbacku",
  "Dispečer + volajúci",
  "Predchádzajúci callback rovnakého čísla bol úspešne vybavený.",
  [
    "Z rovnakého čísla vytvorte nový zmeškaný hovor.",
    "Otvorte frontu callbackov.",
    "Porovnajte novú požiadavku s históriou pôvodnej.",
  ],
  "Nové zmeškanie je nová otvorená požiadavka; starý úspešný kontakt ju nesmie automaticky uzavrieť.",
  { source: "CB · QA-04 · zápisky 4. 9." },
);
scenario(
  "CB",
  2,
  "Neúspešný pokus nie je vybavený kontakt",
  "Dispečer + volajúci",
  "Otvorený callback; volajúci môže odmietnuť alebo nezdvihnúť.",
  [
    "Vytočte callback bez odpovede.",
    "Zopakujte s odmietnutím alebo chybou spojenia.",
    "Overte stav požiadavky a históriu pokusov.",
  ],
  "Samotné vytáčanie ani neúspešné spojenie sa nepočíta ako vybavený callback.",
);
scenario(
  "CB",
  2,
  "Ručné naplánovanie, prevzatie a vybavenie",
  "Dvaja dispečeri",
  "Testovací callback a dohodnuté práva na ručné akcie.",
  [
    "Naplánujte spätný kontakt na konkrétny čas a prevezmite ho.",
    "Ako kolega overte vlastníka a skúste súčasné prevzatie.",
    "Ručne vybavte alebo zrušte určenú požiadavku s vysvetlením.",
  ],
  "Vlastníctvo je zrozumiteľné; súbeh nevytvorí dve nezávislé vybavenia a ručný výsledok má dohľadateľného autora.",
);
scenario(
  "CB",
  2,
  "Rovnaké číslo na rôznych linkách alebo prípadoch",
  "Dispečer + volajúci",
  "Dve testovacie požiadavky rovnakého čísla s odlišným kontextom.",
  [
    "Vytvorte požiadavky na odlišných linkách/prípadoch.",
    "Vybavte len jeden dohodnutý kontakt.",
    "Overte stav druhej požiadavky a príslušné časové údaje.",
  ],
  "Automatické vybavenie rešpektuje dohodnutý kontext a poradie udalostí; nesúvisiaca novšia požiadavka sa nestratí.",
);
scenario(
  "CB",
  2,
  "Oneskorené a opakované dôkazy spojenia",
  "Vývojár",
  "Izolovaný integračný test callbackov a známe časové poradie udalostí.",
  [
    "Doručte potvrdenie staršieho spojenia až po novom zmeškaní.",
    "Doručte tú istú udalosť opakovane a v opačnom poradí.",
    "Overte callback aj prepojenú úlohu v databáze.",
  ],
  "Opakovanie je idempotentné a starý dôkaz nevybaví novšiu požiadavku.",
  { internal: true, source: "CB · existujúce PostgreSQL a automatické testy" },
);

scenario(
  "SMS",
  1,
  "Napísať, skontrolovať a odoslať SMS",
  "Dispečer + príjemca",
  "Schválené testovacie číslo a povolené živé odosielanie.",
  [
    "Otvorte SMS z prípadu, vyberte príjemcu a upravte text.",
    "Skontrolujte náhľad a výslovne odošlite.",
    "Overte stav v histórii aj skutočne prijatú správu.",
  ],
  "Odošle sa práve zamýšľaná správa správnemu príjemcovi; história rozlišuje odoslanie, doručenie a chybu.",
);
scenario(
  "SMS",
  1,
  "Zákazník zdieľa polohu a dispečer ju použije",
  "Dispečer + zákazník na mobile",
  "Testovací prípad a telefón s GPS.",
  [
    "Odošlite lokalizačný odkaz a otvorte ho na telefóne zákazníka.",
    "Povoľte zdieľanie polohy.",
    "Ako dispečer skontrolujte prijatú polohu a vedome ju použite v prípade.",
  ],
  "Poloha patrí správnemu prípadu a neprepíše miesto incidentu bez rozhodnutia dispečera.",
);
scenario(
  "SMS",
  2,
  "Šablóny, kontakty a SMS bez prípadu",
  "Dispečer",
  "Dostupné šablóny a viac kontaktných rolí v testovacom prípade.",
  [
    "Prejdite všetky dostupné šablóny a doplnené údaje.",
    "Zmeňte text a príjemcu; po zmene obnovte náhľad.",
    "Pripravte vlastnú SMS bez prípadu.",
  ],
  "Náhľad vždy zodpovedá aktuálnemu príjemcovi a textu; odoslanie starého náhľadu nepošle nesprávne údaje.",
);
scenario(
  "SMS",
  2,
  "Dvojklik, neisté odoslanie a doručenky",
  "Vývojár + dispečer",
  "Izolované alebo mockované chyby poskytovateľa; určené čísla.",
  [
    "Vyvolajte dvojité odoslanie rovnakej požiadavky.",
    "Simulujte timeout po prijatí správy poskytovateľom.",
    "Doručte potvrdenia opakovane a skontrolujte históriu.",
  ],
  "Nevznikne duplicitná SMS; neistý výsledok sa nezamení za bezpečné nové odoslanie a doručenie sa nevydáva za prečítanie.",
  { internal: true },
);
scenario(
  "SMS",
  2,
  "Expirovaný odkaz a zamietnuté GPS",
  "Zákazník na mobile",
  "Pripravený platný aj expirovaný lokalizačný odkaz.",
  [
    "Otvorte platný odkaz a zamietnite GPS.",
    "Skúste zdieľanie opakovať po povolení GPS.",
    "Otvorte expirovaný alebo neplatný odkaz.",
  ],
  "Každý stav má zrozumiteľný výsledok; neplatný odkaz neodkryje cudzie údaje a opakovanie nevytvorí chybnú polohu.",
);
scenario(
  "SMS",
  2,
  "Prijatá SMS a priradenie ku prípadu",
  "Dispečer + príjemca",
  "Skutočný príjem SMS musí byť aktívny na vhodnom čísle. Inak označte Blokované.",
  [
    "Odošlite odpoveď zo skutočného telefónu na testovacie číslo.",
    "Nájdite správu v prijatých a priraďte ju k správnemu prípadu/operátorovi.",
    "Ako kolega overte prečítanie a súbeh priradenia.",
  ],
  "Prijatá správa je úplná, dohľadateľná a priradená práve k zamýšľanému prípadu; chýbajúci živý príjem sa neoznačí ako úspech.",
);

scenario(
  "MAP",
  1,
  "Miesto zásahu, cieľ a trasa",
  "Dispečer",
  "Testovací prípad s dvoma známymi adresami.",
  [
    "Vyhľadajte miesto incidentu a cieľ odťahu.",
    "Zobrazte trasu, km a ETA.",
    "Uložte prípad a overte body po obnove.",
  ],
  "Trasa vedie medzi správnymi miestami a uložené údaje sú konzistentné s mapou.",
);
scenario(
  "MAP",
  1,
  "Výber vhodnej kapacity na mape",
  "Dispečer",
  "Dve kapacity s rozdielnou polohou alebo dostupnosťou.",
  [
    "Otvorte dostupné kapacity pri incidente.",
    "Porovnajte schopnosti, vzdialenosť a stav.",
    "Vyberte určenú kapacitu a overte priradenie v prípade.",
  ],
  "Mapa a prípad ukazujú rovnakú kapacitu; zastaraný alebo neoverený údaj sa nevydáva za aktuálny.",
);
scenario(
  "MAP",
  2,
  "Ručná poloha, zmena trasy a filtre",
  "Dispečer",
  "Prípad s existujúcou trasou.",
  [
    "Upravte miesto ručne a zmeňte cieľ.",
    "Prepnite vrstvy alebo filtre kapacít.",
    "Skontrolujte prepočet trasy, km a ETA.",
  ],
  "Prepočet používa nové body; stará hodnota sa nezobrazuje ako aktuálna a filtre majú predvídateľný účinok.",
);
scenario(
  "MAP",
  2,
  "Nedostupná mapa, GPS alebo výpočet trasy",
  "Vývojár + dispečer",
  "Riadené blokovanie závislosti iba v testovacom prehliadači/izolovanom prostredí.",
  [
    "Zablokujte odpoveď mapy alebo trasy.",
    "Skúste pokračovať v zápise prípadu.",
    "Obnovte dostupnosť a porovnajte výpočet aj označenie odhadu.",
  ],
  "Výpadok nestratí formulár; odhad/nedostupný údaj má označenie a po obnove možno pokračovať.",
  { internal: true },
);

scenario(
  "VEH",
  1,
  "Ručné EČV, VIN a údaje vozidla",
  "Dispečer",
  "Syntetické alebo povolené testovacie údaje vozidla.",
  [
    "Vyplňte EČV/VIN, značku a relevantné vlastnosti.",
    "Uložte prípad a otvorte ho znovu.",
    "Upravte jeden údaj.",
  ],
  "Zadané údaje sa zachovajú bez neželanej normalizácie alebo prepísania iného poľa.",
);
scenario(
  "VEH",
  1,
  "Dohľadanie a prevzatie údajov vozidla",
  "Dispečer",
  "Známy povolený vstup podporovaného zdroja.",
  [
    "Spustite dohľadanie podľa EČV alebo VIN.",
    "Porovnajte nájdené údaje s existujúcimi ručnými údajmi.",
    "Potvrďte požadované prevzatie a uložte.",
  ],
  "Výsledok má správny zdroj a kontext; ručné údaje sa nesprávne neprepíšu bez dohodnutého postupu.",
);
scenario(
  "VEH",
  2,
  "Zahraničné, neznáme a neúplné vozidlo",
  "Dispečer",
  "Slovenský, zahraničný, neznámy a neúplný testovací vstup.",
  [
    "Vyhľadajte jednotlivé varianty.",
    "Overte dostupné poistné/technické údaje a prvú registráciu podľa podpory zdroja.",
    "Pri chýbajúcom výsledku pokračujte ručným zápisom.",
  ],
  "Aplikácia pravdivo rozlišuje nenájdené, nepodporované a čiastočné výsledky; ručné založenie prípadu ostáva možné.",
);
scenario(
  "VEH",
  2,
  "Pomalý zdroj a zmena vstupu počas hľadania",
  "Vývojár + dispečer",
  "Kontrolované oneskorenie odpovede vyhľadávania.",
  [
    "Spustite hľadanie vozidla A a pred odpoveďou zadajte B.",
    "Doručte odpovede v opačnom poradí.",
    "Vyvolajte timeout a opakujte hľadanie.",
  ],
  "Starý výsledok neprepíše aktuálne vozidlo; stav čakania, chyba a opakovanie sú zrozumiteľné.",
  { internal: true },
);

scenario(
  "FLEET",
  1,
  "Dostupnosť a priradenie techniky",
  "Dispečer",
  "Voľná a obsadená testovacia odťahovka.",
  [
    "Dohľadajte obe vozidlá a porovnajte stav/polohu.",
    "Priraďte vhodné vozidlo testovaciemu prípadu.",
    "Overte prípad, flotilu a opätovné otvorenie.",
  ],
  "Všetky pohľady zobrazujú správnu techniku a pravdivý stav dostupnosti.",
);
scenario(
  "FLEET",
  1,
  "Náhradné vozidlo a obsadenosť",
  "Dispečer",
  "Testovacie náhradné vozidlo a známy termín rezervácie/prenájmu.",
  [
    "Vyhľadajte kapacitu na určený čas.",
    "Priraďte ju alebo zaevidujte dohodnutý stav.",
    "Overte, že obsadenosť je viditeľná aj kolegovi.",
  ],
  "Obsadené vozidlo sa netvári ako voľné a časové údaje zodpovedajú prípadu.",
);
scenario(
  "FLEET",
  2,
  "Správa vozidla, pobočky a schopností",
  "Manažér / administrátor",
  "Oprávnenie spravovať testovaciu kapacitu.",
  [
    "Vytvorte alebo upravte vozidlo vrátane kategórie, pobočky a schopností.",
    "Doplňte vodiča a podporované doklady.",
    "Overte zobrazenie u dispečera.",
  ],
  "Údaje aj filtre zodpovedajú uloženej kapacite; neoprávnený používateľ nemôže meniť správu flotily.",
);
scenario(
  "FLEET",
  2,
  "Servis, offline a zastarané integračné údaje",
  "Dispečer + manažér",
  "Testovacie kapacity v rôznych prevádzkových stavoch.",
  [
    "Prejdite stavy servis, offline, rezervované a prenajaté.",
    "Porovnajte zdroj, čas aktualizácie a neoverenú obsadenosť.",
    "Obnovte integračné údaje v schválenom testovacom režime.",
  ],
  "Stavy sa rozlišujú a zastaraná/neoverená informácia nie je vydávaná za potvrdenú dostupnosť.",
);
scenario(
  "FLEET",
  2,
  "Dve priradenia tej istej kapacity",
  "Dvaja dispečeri",
  "Rovnaká voľná testovacia kapacita a dva prípady v rovnakom čase.",
  [
    "Obaja operátori otvoria pôvodne voľnú kapacitu.",
    "Prvý ju priradí a druhý sa pokúsi o konfliktné priradenie.",
    "Overte výsledok v oboch prípadoch.",
  ],
  "Konflikt je odmietnutý alebo výslovne oznámený podľa dohodnutého procesu; dvojité priradenie sa nedeje potichu.",
);

scenario(
  "DIR",
  1,
  "Nájsť firmu, asistenciu a správny kontakt",
  "Dispečer",
  "Testovacia firma s viacerými osobami a pobočkami.",
  [
    "Vyhľadajte firmu/asistenciu a otvorte pobočku.",
    "Vyberte konkrétny kontakt.",
    "Použite číslo v náhľade hovoru/SMS alebo pri priradení prípadu.",
  ],
  "Použije sa kontakt vybranej osoby/pobočky a dispečer vidí potrebné údaje.",
);
scenario(
  "DIR",
  1,
  "Vytvoriť a upraviť adresárový záznam",
  "Manažér / administrátor",
  "Určená syntetická firma a kontakt.",
  [
    "Vytvorte firmu alebo podporovaný záznam.",
    "Doplňte kontaktnú osobu a pobočku.",
    "Upravte údaj a skontrolujte výsledok u dispečera.",
  ],
  "Vzťahy firmy, osoby a pobočky sa uložia správne; dispečer má dohodnuté čítanie a použitie kontaktu.",
);
scenario(
  "DIR",
  2,
  "Archivácia, obnova a podobné záznamy",
  "Manažér / administrátor",
  "Testovacia firma použitá v historickom prípade.",
  [
    "Overte podobné názvy a zabráňte nechcenému vytvoreniu kópie.",
    "Archivujte a obnovte firmu podporovanou akciou.",
    "Overte historický prípad a dostupnosť kontaktov.",
  ],
  "Archivácia nezničí históriu; obnova je dohľadateľná a používateľ vie rozlíšiť podobné záznamy.",
);
scenario(
  "DIR",
  2,
  "Súbežné a čiastočne úspešné uloženie",
  "Dvaja správcovia / vývojár",
  "Rovnaký testovací záznam v dvoch prehliadačoch; izolovaná simulácia zlyhania prepojenia kontaktu.",
  [
    "Uložte konfliktné úpravy z oboch prehliadačov.",
    "Overte zachovanie druhého rozpracovaného formulára.",
    "Vyvolajte vytvorenie kontaktu s následným zlyhaním jeho prepojenia.",
  ],
  "Konflikt sa oznámi; čiastočný úspech jasne uvedie, čo vzniklo, a opakovanie nevytvorí nevedomú kópiu.",
  { internal: true },
);
scenario(
  "DIR",
  2,
  "Import asistencií a história pobočky",
  "Manažér / administrátor",
  "Dohodnutý testovací import; prípad s pôvodnou polohou pobočky.",
  [
    "Skontrolujte náhľad a spustite povolený import.",
    "Overte správne väzby a správanie pri opakovaní.",
    "Zmeňte adresu pobočky a otvorte starší prípad.",
  ],
  "Import nevytvorí nesprávne prepojenia; historické miesto zásahu/pobočky v staršom prípade sa neprepíše dnešnou adresou.",
);

scenario(
  "REC",
  1,
  "Oznámenie, stav a zastavenie nahrávania",
  "Dispečer + volajúci",
  "Nahrávanie je v rozsahu kola a zapnuté; dohodnuté oznámenie.",
  [
    "Spojte testovací hovor a vypočujte oznámenie.",
    "Overte zobrazený stav nahrávania.",
    "Zastavte nahrávanie a po ukončení porovnajte výsledný záznam.",
  ],
  "Oznámenie aj stav sú pravdivé; úspešné zastavenie je potvrdené a následný súkromný obsah nie je v zázname.",
);
scenario(
  "REC",
  1,
  "Prístup k nahrávke podľa oprávnenia",
  "Manažér + dispečer",
  "Hotová testovacia nahrávka; dohodnutá matica rolí a osobitných oprávnení.",
  [
    "Otvorte záznam oprávneným účtom.",
    "Skúste rovnaký záznam dispečerom bez príslušného práva.",
    "Overte aj priamy odkaz na prehrávanie.",
  ],
  "Nahrávku možno prehrať iba s príslušným oprávnením; skrytý odkaz sám nie je ochranou.",
);
scenario(
  "REC",
  2,
  "Prepojený hovor, segmenty a súkromná konzultácia",
  "Dvaja dispečeri + manažér",
  "Zapnuté nahrávanie a konzultované prepojenie.",
  [
    "Nahrajte testovací hovor s konzultáciou a prepojením.",
    "Prehrajte výsledné segmenty v poradí.",
    "Overte medzery aj vylúčenie súkromnej konzultácie.",
  ],
  "Prehrávanie netvrdí úplnosť pri chýbajúcom segmente a súkromná časť sa nesprístupní ako rozhovor so zákazníkom.",
);
scenario(
  "REC",
  2,
  "Prepis, AI návrh a ľudské schválenie",
  "Manažér + hodnotený operátor",
  "Pripravený prepis testovacej nahrávky; hodnotenie je zapnuté.",
  [
    "Skontrolujte prepis a opravte chybu podporovanou akciou.",
    "Prejdite návrh hodnotenia a výslovne ho schváľte.",
    "Ako operátor otvorte vlastné schválené hodnotenie a podajte námietku.",
  ],
  "AI návrh sa nevydáva za schválené hodnotenie; operátor vidí iba povolený vlastný obsah a námietka sa uloží.",
);
scenario(
  "REC",
  2,
  "Neúplné spracovanie, retencia a odstránenie",
  "Vývojár + manažér",
  "Určený testovací záznam; schválené pravidlá retencie, izolované zlyhanie spracovania.",
  [
    "Overte čakajúci, chybný a čiastočný výsledok spracovania.",
    "Vykonajte dohodnutý postup odstránenia testovacieho záznamu.",
    "Overte audio, prepis, prístupové odkazy a dohľadateľný stav odstránenia.",
  ],
  "Chyba nevyzerá ako úspešný prepis; odstránenie má pravdivý stav a rozsah podľa pravidiel vydania.",
  { internal: true },
);

scenario(
  "ATT",
  1,
  "Začiatok a koniec evidovanej práce",
  "Dispečer",
  "Testovací účet s dostupnou dochádzkou.",
  [
    "Začnite evidenciu práce a overte aktuálny záznam.",
    "Zmeňte telefónnu dostupnosť alebo zapnite pauzu.",
    "Ukončite evidenciu práce a obnovte prehľad.",
  ],
  "Pracovný čas je uložený; dochádzka sa nezamieňa s telefónnou dostupnosťou a nevznikne duplicitná otvorená evidencia.",
);
scenario(
  "ATT",
  1,
  "Pridelená smena a vlastný prehľad",
  "Manažér + dispečer",
  "Testovací plán smien.",
  [
    "Manažér pridelí a publikuje smenu.",
    "Dispečer otvorí vlastný plán a potvrdí/odmietne podľa možností.",
    "Manažér skontroluje výsledok.",
  ],
  "Obaja vidia rovnaký čas, osobu a stav; koncept sa nespráva ako oznámená publikovaná smena.",
);
scenario(
  "ATT",
  2,
  "Kopírovanie, hromadný plán a konflikty",
  "Manažér",
  "Testovací týždeň s existujúcou smenou.",
  [
    "Skopírujte deň/týždeň alebo použite hromadné plánovanie.",
    "Vytvorte prekrývajúci sa návrh a skontrolujte konflikt.",
    "Publikujte platný plán a overte ho u používateľov.",
  ],
  "Kopírovanie zachová správne dni a ľudí; konflikt je zrozumiteľný a publikovanie nevytvorí skryté duplicity.",
);
scenario(
  "ATT",
  2,
  "Žiadosti, schválenie a časové hranice",
  "Dispečer + manažér",
  "Testovacie voľno/neprítomnosť a smena cez polnoc; prechod času overovať izolovane.",
  [
    "Podajte a schváľte/odmietnite žiadosť.",
    "Skontrolujte dosah na plán a vlastný prehľad.",
    "Overte nočnú smenu, hranicu mesiaca a dohodnutú časovú zónu.",
  ],
  "Stavy žiadosti sú dohľadateľné; dátumy a odpracovaný čas sú správne aj cez časové hranice.",
);

scenario(
  "REP",
  1,
  "Súhrny sedia so známymi dátami",
  "Manažér",
  "Malý známy súbor testovacích hovorov, prípadov a úloh s očakávanými počtami.",
  [
    "Otvorte príslušné súhrny a nastavte obdobie.",
    "Porovnajte počty so zdrojovými záznamami.",
    "Dokončite určenú testovaciu položku a obnovte prehľad.",
  ],
  "Počty a význam stavov zodpovedajú zdrojovým dátam; obnova nezapočíta položku dvakrát.",
);
scenario(
  "REP",
  1,
  "Wallboard a prístup k reportom",
  "Manažér + dispečer",
  "Dohodnutá matica prístupu a testovací nástenný prehľad.",
  [
    "Otvorte reporty oprávnenou osobou.",
    "Overte rovnaký prístup bežným dispečerom podľa dohody.",
    "Sledujte wallboard počas testovacieho hovoru a jeho ukončenia.",
  ],
  "Reporty rešpektujú rolu a wallboard po dohodnutom intervale zodpovedá aktuálnemu stavu.",
);
scenario(
  "REP",
  2,
  "Všetky pohľady a časové obdobia",
  "Manažér",
  "Dáta rozložené cez hranicu dňa a obdobia.",
  [
    "Prejdite prehľad, hovory, kvalitu, operátorov a prípady.",
    "Porovnajte dnes, 7 a 30 dní a dostupné filtre.",
    "Skontrolujte časovú zónu a položky na hranici obdobia.",
  ],
  "Rovnaké metriky majú konzistentný význam a každá položka patrí do správneho obdobia a operátora.",
);
scenario(
  "REP",
  2,
  "Prázdne a čiastočné reporty",
  "Manažér / vývojár",
  "Filter bez dát a izolovane nedostupný zdroj metriky.",
  [
    "Otvorte pohľad bez výsledkov.",
    "Vyvolajte nedostupnosť jednej metriky v testovacom prostredí.",
    "Obnovte dostupnosť a prehľad.",
  ],
  "Nula sa rozlišuje od chyby alebo chýbajúceho zdroja; ostatné dostupné časti zostávajú použiteľné.",
  { internal: true },
);

scenario(
  "OPS",
  1,
  "Celý základný postup na fyzickom mobile",
  "Dispečer",
  "Podporovaný iPhone alebo Android; typ prehliadača/PWA zapíšte do zariadenia kola.",
  [
    "Na mobile vstúpte, nájdite prípad a upravte jeho údaj.",
    "Vytvorte a dokončite úlohu, otvorte upozornenie.",
    "Overte formulár s klávesnicou, otočenie a návrat do prehľadu.",
  ],
  "Základnú prácu možno dokončiť bez prekrytých tlačidiel, vodorovného posúvania celej stránky alebo straty formulára.",
);
scenario(
  "OPS",
  1,
  "Známa konfigurácia linky a povolenia",
  "Administrátor + dispečer",
  "V podmienkach kola sú zapísané testovacie čísla, zapnuté funkcie a pracovný čas.",
  [
    "Overte dostupnú linku, mikrofón a podporovaný režim zariadenia.",
    "Porovnajte osobné nastavenia so správaním hovoru/upozornení.",
    "Overte, že chýbajúca konfigurácia má zrozumiteľné vysvetlenie.",
  ],
  "Tím vie, čo je v kole aktívne; vypnutá alebo nenakonfigurovaná požadovaná funkcia sa nevydáva za úspešný test.",
);
scenario(
  "OPS",
  2,
  "IVR, pracovný čas a Europe Assistance",
  "Administrátor + volajúci",
  "Schválený zoznam liniek, menu, jazykov a smerovania. Použite iba testovacie čísla.",
  [
    "Overte jednotlivé dohodnuté voľby IVR a hlášky.",
    "Skontrolujte správanie v pracovnom čase, mimo neho a bez dostupných operátorov.",
    "Overte príslušnú linku Europe Assistance a návrat konfigurácie.",
  ],
  "Každá dohodnutá trasa a hláška vedie k zamýšľanému výsledku; chýbajúca linka ostáva viditeľnou medzerou.",
);
scenario(
  "OPS",
  2,
  "Skupiny, dôvody pauzy a nastavenia",
  "Administrátor + dispečer",
  "Testovacia skupina/plán a dovolené zmeny nastavení.",
  [
    "Upravte povolené skupiny, plán a dôvody pauzy.",
    "Overte zobrazenie a smerovanie u príslušného dispečera.",
    "Nechajte uplynúť pripomienku konca pauzy.",
  ],
  "Nastavenie má dohodnutý dosah; upozornenie na koniec pauzy samo nepreklopí operátora na pripraveného.",
);
scenario(
  "OPS",
  2,
  "Mobil na pozadí, zámok a prepnutie siete",
  "Dispečer + volajúci",
  "Fyzický mobil/PWA, povolené upozornenia a koordinovaný hovor.",
  [
    "Prepnite aplikáciu do pozadia a zamknite obrazovku.",
    "Overte podporovaný príchod upozornenia/hovoru a návrat do aplikácie.",
    "Prepnite Wi-Fi/mobilné dáta a skontrolujte obnovu stavu.",
  ],
  "Správanie zodpovedá dohodnutej podpore zariadenia; po návrate nezostane nepravdivý hovor ani dostupnosť.",
);
scenario(
  "OPS",
  2,
  "Viac kariet a aktualizácia PWA",
  "Dispečer + vývojár",
  "Dve karty rovnakého účtu a pripravené nové testovacie vydanie.",
  [
    "Otvorte dve karty a overte prítomnosť operátora a ovládanie hovorov.",
    "Ponúknite aktualizáciu PWA počas rozpísanej práce alebo hovoru.",
    "Dokončite prácu a bezpečne aktualizujte.",
  ],
  "Karty nevytvoria nepravdivú dostupnosť; aktualizácia nepreruší prebiehajúcu prácu a po nej sa načíta správna verzia.",
);
scenario(
  "OPS",
  2,
  "Databáza: uloženie, opakovanie a väzby",
  "Vývojár",
  "Izolované prostredie; žiadne poruchy na spoločnej databáze testerov.",
  [
    "Simulujte chybu pred uložením aj stratenú odpoveď po úspešnom zápise.",
    "Zopakujte rovnakú akciu a súbežné zmeny.",
    "Overte riadky, väzby, históriu a obnovený stav používateľského rozhrania.",
  ],
  "Aplikácia nehlási neuložené údaje ako uložené, nevytvára nevedomé duplicity a zachováva väzby a audit.",
  { internal: true },
);
scenario(
  "OPS",
  2,
  "Výkon na reprezentatívnych objemoch",
  "Vývojár",
  "Dopredu zapísaný objem dát, súbeh a prijateľná odozva; izolované prostredie pre objemový test.",
  [
    "Zmerajte otvorenie pracoviska, zoznamov, vyhľadávanie a uloženie pri dohodnutom objeme.",
    "Zopakujte meranie pri dohodnutom súbehu a počas hovoru.",
    "Skontrolujte pomalé dotazy, indexy, stránkovanie a veľkosť prenášaných dát.",
  ],
  "Merania spĺňajú vopred zapísané ciele; štyri skúšobné hovory sa nevydávajú za celkový kapacitný limit.",
  { internal: true },
);
scenario(
  "OPS",
  2,
  "Integrácie, opakované udalosti a obnova",
  "Vývojár",
  "Izolované testy poskytovateľov a opakovaných webhookov; žiadny nový worker/listener.",
  [
    "Overte podpisy a odmietnutie neplatných integračných vstupov.",
    "Doručte udalosti opakovane, oneskorene a v inom poradí.",
    "Obnovte službu a skontrolujte zosúladenie uloženého stavu.",
  ],
  "Neplatná udalosť nemení dáta; opakovanie a obnova nespôsobia duplicitnú prácu ani nesprávny konečný stav.",
  { internal: true },
);
scenario(
  "OPS",
  2,
  "Nasadenie, kompatibilita a návrat vydania",
  "Vývojár",
  "Povolená Telnyx kópia, presný build a existujúce MG-02/MG-03 scenáre; koordinovaný postup.",
  [
    "Overte MG-02 s platnými vstupmi podľa existujúcej špecifikácie.",
    "Vykonajte nasadený MG-03 a skontrolujte kompatibilitu starého otvoreného klienta.",
    "Overte dohodnutý návrat vydania a zdravie povoleného cronu bez spúšťania nových listenerov.",
  ],
  "Existujúce brány majú skutočný dôkaz z konkrétnej verzie; samotná odpoveď health alebo syntetický test nenahradí živú kompatibilitu.",
  {
    internal: true,
    source: "MG-02 · MG-03 · docs/operations/telephony-stability-rollout.md",
  },
);

export const catalog: Scenario[] = definitions;
