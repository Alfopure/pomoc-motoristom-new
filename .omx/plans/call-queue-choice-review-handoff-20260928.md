# Plánovací handoff: čakáreň a výber hovoru

- Stav plánovania: dokončené 2026-09-28 09:38 UTC.
- Podklady: `call-queue-choice-20260928.md`, `test-spec-call-queue-choice-20260928.md`, `../context/call-queue-choice-20260928T093100Z.md`.
- Technická revízia po dvoch iteráciách: APPROVE. Doplnila povinné konkrétne `callControlId` a režim čakárne aj pri prázdnom pláne.
- Kritická revízia po dvoch iteráciách: APPROVE. Doplnila ACL/push, fallback pri blokovanom browser audiu, statické vizuálne zvýraznenie a testy dvoch kariet.
- Realizácia a produkčné nasadenie sú výslovne vyžiadané používateľom v tomto rozhovore. Pracovná vetva `feat/queue-choice-alerts` vychádza z `origin/dev`; ďalšia fáza je implementácia, overenie, Preview a projektový dev→main release.
- V prostredí nie je príkaz `omx`; tento súbor zachytáva obyčajnú lokálnu revíziu, **nie** host-issued Ralplan consensus gate. Skill `ralph` je v dostupnom balíku sunset stub a odkazuje na Ultragoal; jeho completion/verification zásady použijeme bez predstierania OMX ledgeru alebo Codex goal-mode.
