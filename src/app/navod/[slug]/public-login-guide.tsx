import Link from "next/link";
import { ArrowLeft, ArrowUpRight, BookOpen } from "lucide-react";
import type { GuideChapter } from "@/content/guide/types";
import screenshots from "@/content/guide/screenshots.json";

/** Public account help, deliberately server-rendered without the full guide corpus. */
export function LoginGuide({ chapter }: { chapter: GuideChapter }) {
  return (
    <main className="min-h-screen bg-[#f8f7f3] px-5 py-8 text-zinc-900 sm:py-14">
      <div className="mx-auto max-w-3xl">
        <Link href="/" className="inline-flex min-h-11 items-center gap-2 text-sm font-semibold text-zinc-600 hover:text-zinc-950"><ArrowLeft size={16} /> Späť na prihlásenie</Link>
        <div className="mt-8 rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm sm:p-10">
          <span className="inline-flex items-center gap-2 rounded-full bg-yellow-100 px-3 py-1.5 text-xs font-semibold"><BookOpen size={14} /> Pomoc motoristom · Návod</span>
          <h1 className="mt-5 text-3xl font-semibold leading-tight sm:text-4xl">{chapter.title}</h1>
          <p className="mt-4 leading-7 text-zinc-600">{chapter.description}</p>
          {chapter.sections.map(section => (
            <section key={section.id} id={section.id} className="mt-9 scroll-mt-8 border-t border-zinc-100 pt-7">
              <h2 className="text-xl font-semibold">{section.title}</h2>
              {section.paragraphs?.map(text => <p key={text} className="mt-3 leading-7 text-zinc-600">{text}</p>)}
              {section.steps && <ol className="mt-4 space-y-5">{section.steps.map((step, index) => <li id={step.id} key={step.id} className="flex gap-3"><span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-xs font-bold text-white">{index + 1}</span><div><h3 className="font-semibold">{step.title}</h3><p className="mt-1 leading-7 text-zinc-600">{step.text}</p>{step.result && <p className="mt-2 text-sm leading-6 text-zinc-600">{step.result}</p>}</div></li>)}</ol>}
              {section.bullets && <ul className="mt-3 list-disc space-y-2 pl-5 leading-7 text-zinc-600">{section.bullets.map(text => <li key={text}>{text}</li>)}</ul>}
              {section.table && <div className="mt-4 overflow-x-auto rounded-xl border border-zinc-200"><table className="w-full text-left text-sm leading-6"><thead className="bg-zinc-50"><tr>{section.table.headers.map(header => <th key={header} className="p-3 font-semibold">{header}</th>)}</tr></thead><tbody>{section.table.rows.map((row, index) => <tr key={index} className="border-t border-zinc-200">{row.map((cell, cellIndex) => <td key={cellIndex} className="p-3 align-top text-zinc-600">{cell}</td>)}</tr>)}</tbody></table></div>}
              {section.note && <aside className="mt-4 rounded-xl border border-yellow-200 bg-yellow-50 p-4"><p className="font-semibold">{section.note.title}</p><p className="mt-1 text-sm leading-6">{section.note.text}</p></aside>}
              {(section.screenshotIds ?? []).map(id => {
                const image = screenshots.find(item => item.id === id);
                if (!image) return null;
                return <figure key={id} className="mt-5 overflow-hidden rounded-xl border border-zinc-200">
                  <a href={`/guide-assets/${image.file}`} target="_blank" rel="noopener noreferrer" className="relative block" aria-label={`Zväčšiť obrázok: ${image.title} (nová karta)`}>
                    {/* Native img keeps this public illustration portable and unprocessed. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`/guide-assets/${image.file}`} width={image.width} height={image.height} alt={image.alt} className="block h-auto w-full" />
                    {image.annotations.map((mark, index) => <span key={mark.id} aria-hidden="true" className="absolute rounded-md border-2 border-blue-600" style={{ left: `${mark.x}%`, top: `${mark.y}%`, width: `${mark.width}%`, height: `${mark.height}%` }}><span className="absolute -left-2 -top-2 flex h-5 w-5 items-center justify-center rounded-full bg-blue-600 text-[10px] font-bold text-white">{index + 1}</span></span>)}
                  </a>
                  <figcaption className="space-y-1 bg-zinc-50 p-3 text-xs leading-5 text-zinc-600">{image.annotations.map((mark, index) => <p key={mark.id}>{index + 1}. {mark.label}</p>)}<p>Ukážkové údaje. Kliknutím obrázok zväčšíte.</p></figcaption>
                </figure>;
              })}
            </section>
          ))}
          <div className="mt-9 flex flex-wrap gap-3 border-t border-zinc-100 pt-6">
            <Link href="/" className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-zinc-900 px-5 py-3 text-sm font-semibold text-white">Prihlásiť sa <ArrowUpRight size={16} /></Link>
            <Link href="/auth/forgot-password" className="inline-flex min-h-11 items-center rounded-xl border border-zinc-200 px-5 py-3 text-sm font-semibold">Obnoviť heslo</Link>
            <Link href="/navod" className="inline-flex min-h-11 items-center px-2 text-sm font-semibold text-zinc-600">Celý návod po prihlásení →</Link>
          </div>
        </div>
      </div>
    </main>
  );
}
