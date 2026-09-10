"use client";

import { useState } from "react";
import { calculateExpression } from "./calculator";

export function CalculatorWidget() {
  const [expression, setExpression] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  function calculate() {
    try { setResult(calculateExpression(expression).toLocaleString("sk-SK", { maximumFractionDigits: 12, useGrouping: false })); setNotice(null); }
    catch (error) { setResult(null); setNotice(error instanceof Error ? error.message : "Skontrolujte výraz."); }
  }
  return <form onSubmit={event => { event.preventDefault(); calculate(); }} className="space-y-3 p-3">
    <label className="block text-sm font-medium">Výpočet
      <input value={expression} onChange={event => { setExpression(event.target.value); setResult(null); setNotice(null); }} placeholder="(70 − 50) × 2 × 0,75" maxLength={300} className="mt-1 min-h-11 w-full rounded-lg border border-zinc-300 px-3 text-base" />
    </label>
    <div className="grid grid-cols-4 gap-1">
      {["7", "8", "9", "÷", "4", "5", "6", "×", "1", "2", "3", "−", "0", ",", "(", ")", "+"].map(key => <button key={key} type="button" className="min-h-11 rounded-lg bg-zinc-100 text-base font-medium hover:bg-zinc-200" onClick={() => { setExpression(current => (current + key).slice(0, 300)); setResult(null); setNotice(null); }}>{key}</button>)}
      <button type="button" className="col-span-2 min-h-11 rounded-lg text-sm hover:bg-zinc-100" onClick={() => { setExpression(""); setResult(null); setNotice(null); }}>Vymazať</button>
      <button type="submit" className="min-h-11 rounded-lg bg-zinc-950 font-bold text-white">=</button>
    </div>
    {result !== null && <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-yellow-50 p-2"><output className="break-all text-xl font-semibold">{result}</output><button type="button" className="min-h-11 px-2 text-sm" onClick={() => void navigator.clipboard.writeText(result).then(() => setNotice("Výsledok skopírovaný."), () => setNotice("Kopírovanie nie je dostupné. Označte výsledok a skopírujte ho ručne."))}>Kopírovať</button></div>}
    {notice && <p role="status" className="text-sm text-zinc-700">{notice}</p>}
  </form>;
}
