# AI demo „Veronika“ — aktuálne umiestnenie

**Samostatná kópia je vyradená od 2026-10-18.** Vercel projekt `pomoc-motoristom-aidemo` bol odstránený. Starý návod na jeho vytvorenie, kopírovanie credentials a plošné aplikovanie migrácií už neplatí. `scripts/setup-ai-demo-copy.sh` teraz iba vysvetlí vyradenie a skončí s kódom 1, ešte pred načítaním secrets alebo spustením externého príkazu.

AI demo je súčasťou tohto dispečingu: administrátorská záložka **AI** v nastaveniach telefónie (`AiTab`, `AiDemoPanel`, `AiAgentSettingsPanel`), serverové routy `/api/telephony/ai-demo/*` a implementácia `src/server/telephony/ai-demo/`. Viditeľnosť záložky a pripravenosť operácií závisia od efektívnej konfigurácie; samotná existencia kódu nepreukazuje zapnutie ani funkčný živý hovor.

Na lokálne overenie logiky bez providerov slúži:

```bash
pnpm exec vitest run src/server/telephony/ai-demo src/app/api/telephony/webhooks/openai
```

Testy používajú falošných providerov. Nepotvrdzujú zvuk, latenciu ani konfiguráciu živých webhookov. Historické [demo plány](ai-demo-plan.md) a [návrh produkčnej AI](ai-production-plan.md) sú záznamy návrhu, nie povolenie vytvárať infraštruktúru alebo aktuálny dôkaz nasadenia.

Zmeny dodávaj cez [release workflow](release-workflow.md). Stabilný TEST je `https://test.dispecing.linkapomoci.sk`; pracovný Preview nesmie používať jeho živé provider resources. Živá skúška musí rešpektovať aktuálne povolenia a izoláciu z [TEST runbooku](full-test-environment.md) a [telefónnej politiky](test-phone-number-policy.md). Nevytváraj ďalšie kópie aplikácie, nekopíruj produkčné credentials a nepridávaj worker ani scheduler. Databázové zmeny vyžadujú konkrétny autorizovaný projekt a SQL rozsah.
