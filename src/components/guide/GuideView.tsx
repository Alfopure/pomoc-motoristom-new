"use client";

import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, BookOpen, Check, CheckCircle2, ChevronDown, ChevronRight, Clock3, Compass, Copy, Headphones, Info, List, Menu, Phone, Search, Settings2, ShieldCheck, Users, Wrench, X, ZoomIn } from "lucide-react";
import type { GuideCategory, GuideChapter, GuideScreenshot, GuideSection } from "../../content/guide/types";
import { searchGuide } from "./search";
import "./guide.css";

export type GuidePaths = { basePath?: string; assetBasePath?: string; linkSuffix?: string };
export type GuideViewProps = GuidePaths & {
  chapter?: GuideChapter;
  chapters: GuideChapter[];
  categories: GuideCategory[];
  screenshots: GuideScreenshot[];
  updatedAt: string;
  version: string;
};
type Paths = Required<GuidePaths>;
const categoryIcons = { start: Compass, phone: Phone, cases: List, settings: Settings2, team: Users, help: Wrench };
const audienceNames = { all: "Pre všetkých", manager: "Pre vedúcich a administrátorov", admin: "Pre administrátorov" };
const chapterHref = (paths: Paths, slug: string, anchor?: string) => `${paths.basePath}/${slug}${paths.linkSuffix}${anchor ? `#${anchor}` : ""}`;
const homeHref = (paths: Paths) => paths.linkSuffix ? `${paths.basePath}/index${paths.linkSuffix}` : paths.basePath;

function ChapterLink({ slug, chapters, paths, children, className }: { slug: string; chapters: GuideChapter[]; paths: Paths; children?: ReactNode; className?: string }) {
  const chapter = chapters.find((item) => item.slug === slug);
  if (!chapter) return null;
  return <a className={className} href={chapterHref(paths, slug)}>{children ?? chapter.title}<ArrowRight size={16} aria-hidden="true" /></a>;
}

function GuideSearch({ chapters, paths, compact = false }: { chapters: GuideChapter[]; paths: Paths; compact?: boolean }) {
  const [query, setQuery] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const searchId = useId();
  const results = useMemo(() => searchGuide(query, chapters), [query, chapters]);
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      if (event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey && !target.closest("input, textarea, select, [contenteditable=true], dialog[open]")) {
        event.preventDefault();
        input.current?.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);
  return <div className={`guide-search ${compact ? "guide-search--compact" : ""}`}>
    <label className="guide-sr-only" htmlFor={searchId}>Vyhľadať v celom návode</label>
    <div className="guide-search-input">
      <Search size={21} aria-hidden="true" />
      <input ref={input} id={searchId} type="search" autoComplete="off" placeholder={compact ? "Hľadať v návode…" : "Čo potrebujete vedieť? Napríklad pauza alebo zvonenie"} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") { setQuery(""); input.current?.blur(); } }} aria-controls={`${searchId}-results`} />
      {!query && <kbd aria-hidden="true">/</kbd>}
    </div>
    {query.trim() && <div id={`${searchId}-results`} className="guide-search-results">
      <div className="guide-search-heading" role="status">{results.length ? `Nájdené postupy · ${results.length}` : "Nenašli sme zodpovedajúci postup"}<button type="button" onClick={() => { setQuery(""); input.current?.focus(); }} aria-label="Zavrieť výsledky vyhľadávania"><X size={17} /></button></div>
      {results.length ? <ul>{results.map((result) => <li key={`${result.chapterSlug}-${result.anchor ?? "chapter"}`}><a href={chapterHref(paths, result.chapterSlug, result.anchor)}><span className="guide-search-context">{result.chapterTitle}</span><strong>{result.title}</strong><span>{result.excerpt}</span><ArrowRight size={16} aria-hidden="true" /></a></li>)}</ul> : <p>Skúste kratší výraz, napríklad „čakáreň“, „mikrofón“ alebo „heslo“. Hľadať môžete aj bez diakritiky.</p>}
    </div>}
  </div>;
}

function Sidebar({ chapter, chapters, categories, paths, onNavigate }: { chapter?: GuideChapter; chapters: GuideChapter[]; categories: GuideCategory[]; paths: Paths; onNavigate?: () => void }) {
  return <div className="guide-sidebar-inner">
    <a className="guide-brand" href={homeHref(paths)} onClick={onNavigate}><span className="guide-brand-mark"><Headphones size={24} strokeWidth={2.1} /></span><span>Linka pomoci<small>Príručka dispečera</small></span></a>
    <div className="guide-sidebar-label">VÁŠ SPRIEVODCA</div>
    <nav className="guide-navigation" aria-label="Kapitoly návodu">
      <a className={`guide-nav-home ${!chapter ? "is-current" : ""}`} href={homeHref(paths)} aria-current={!chapter ? "page" : undefined} onClick={onNavigate}><BookOpen size={18} />Prehľad návodu<ArrowRight size={15} /></a>
      {categories.map((category) => {
        const Icon = categoryIcons[category.icon];
        return <details className="guide-nav-category" key={category.id} open={chapter?.categoryId === category.id || undefined}>
          <summary><Icon size={18} /><span>{category.title}</span><ChevronDown size={14} /></summary>
          <ul>{chapters.filter((item) => item.categoryId === category.id).map((item) => <li key={item.slug}><a href={chapterHref(paths, item.slug)} aria-current={chapter?.slug === item.slug ? "page" : undefined} onClick={onNavigate}>{item.title}</a></li>)}</ul>
        </details>;
      })}
    </nav>
    <div className="guide-sidebar-help"><span className="guide-sidebar-help-icon"><Wrench size={18} /></span><strong>Niečo nefunguje?</strong><p>Prejdite najčastejšie situácie a ich riešenia.</p><ChapterLink slug="riesenie-problemov" chapters={chapters} paths={paths}>Nájsť riešenie</ChapterLink></div>
    <div className="guide-sidebar-foot"><span className="guide-status-dot" />Pomoc pri každodennej práci</div>
  </div>;
}

function CopyLink({ anchor, compact = false }: { anchor?: string; compact?: boolean }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timeout.current) clearTimeout(timeout.current); }, []);
  async function copy() {
    const url = new URL(window.location.href);
    if (anchor) url.hash = anchor;
    try { await navigator.clipboard.writeText(url.href); setStatus("copied"); } catch { setStatus("failed"); }
    if (timeout.current) clearTimeout(timeout.current);
    timeout.current = setTimeout(() => setStatus("idle"), 2500);
  }
  const label = status === "copied" ? "Odkaz skopírovaný" : status === "failed" ? "Skopírujte adresu z prehliadača" : "Kopírovať odkaz";
  return <button className={`guide-copy ${compact ? "guide-copy--compact" : ""}`} type="button" onClick={copy} aria-label={label} title={label}>{status === "copied" ? <Check size={16} /> : <Copy size={16} />}{!compact && <span aria-live="polite">{label}</span>}</button>;
}

function AnnotatedScreenshot({ screenshot, paths }: { screenshot: GuideScreenshot; paths: Paths }) {
  const [selected, setSelected] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const file = `${paths.assetBasePath}/${screenshot.file}`;
  useEffect(() => {
    function onHash() {
      let hash = window.location.hash.slice(1);
      try { hash = decodeURIComponent(hash); } catch { return; }
      if (screenshot.annotations.some((annotation) => annotation.id === hash)) setSelected(hash);
    }
    onHash();
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [screenshot]);
  function close() { dialog.current?.close(); trigger.current?.focus(); }
  function imageLayer(zoom = false) {
    return <div className={`guide-shot-canvas ${selected ? "has-selection" : ""}`} style={{ aspectRatio: `${screenshot.width} / ${screenshot.height}` }}>
      {/* The unmodified capture is shared with the HTML annotation layer and standalone guide. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={file} alt={screenshot.alt} width={screenshot.width} height={screenshot.height} loading={zoom ? "eager" : "lazy"} />
      {screenshot.annotations.map((annotation, index) => <button key={annotation.id} type="button" className={`guide-annotation ${selected === annotation.id ? "is-selected" : ""}`} style={{ left: `${annotation.x}%`, top: `${annotation.y}%`, width: `${annotation.width}%`, height: `${annotation.height}%` } as CSSProperties} aria-label={`${index + 1}. ${annotation.label}`} aria-pressed={selected === annotation.id} onClick={() => setSelected(selected === annotation.id ? null : annotation.id)}><span>{index + 1}</span></button>)}
    </div>;
  }
  function legend(zoom = false) {
    return <ol className="guide-shot-legend">{screenshot.annotations.map((annotation, index) => <li key={annotation.id} id={zoom ? undefined : annotation.id}><button type="button" aria-pressed={selected === annotation.id} onClick={() => setSelected(selected === annotation.id ? null : annotation.id)}><span className="guide-legend-number">{index + 1}</span><span>{annotation.label}</span></button></li>)}</ol>;
  }
  return <figure className={`guide-shot ${screenshot.width < screenshot.height ? "guide-shot--portrait" : ""}`} id={screenshot.id}>
    <div className="guide-shot-topline"><span><span className="guide-small-dot" />{screenshot.title}</span><button ref={trigger} type="button" onClick={() => dialog.current?.showModal()} aria-label={`Zväčšiť obrázok: ${screenshot.title}`}><ZoomIn size={16} /><span>Zväčšiť</span></button></div>
    {imageLayer()}
    <figcaption>{screenshot.annotations.length > 0 && legend()}<p className="guide-shot-note">Ukážka s tréningovými údajmi. Čísla označujú vysvetlené prvky.</p></figcaption>
    <dialog className="guide-zoom" ref={dialog} aria-labelledby={titleId} onCancel={() => trigger.current?.focus()} onClick={(event) => { if (event.target === dialog.current) close(); }}>
      <div className="guide-zoom-header"><div><span className="guide-eyebrow">POHĽAD DO APLIKÁCIE</span><h2 id={titleId}>{screenshot.title}</h2></div><button type="button" onClick={close} aria-label="Zavrieť zväčšený obrázok" autoFocus><X size={22} /></button></div>
      <div className="guide-zoom-scroll">{imageLayer(true)}</div>{legend(true)}
      <p className="guide-shot-note">Kliknite na číslo a zvýraznite príslušný prvok. Väčší obrázok môžete posúvať do strán. Okno zavriete aj klávesom Esc.</p>
    </dialog>
  </figure>;
}

function HomeContent({ chapters, categories, paths }: { chapters: GuideChapter[]; categories: GuideCategory[]; paths: Paths }) {
  return <div className="guide-home">
    <section className="guide-hero" aria-labelledby="guide-welcome">
      <div className="guide-hero-content"><span className="guide-eyebrow"><span className="guide-eyebrow-line" />PRAKTICKY. KROK ZA KROKOM.</span><h1 id="guide-welcome">Istota pri{" "}<br />každom hovore<span>.</span></h1><p>Od prvej služby po nastavenie zvonenia. Spoznajte aplikáciu cez zrozumiteľné postupy a obrázky.</p><GuideSearch chapters={chapters} paths={paths} /><div className="guide-popular"><span>Často hľadané</span>{[["pauza-a-zastupovanie", "Pauza"], ["cakaren", "Čakáreň"], ["plany-zvonenia", "Kroky zvonenia"]].map(([slug, title]) => <a key={slug} href={chapterHref(paths, slug)}>{title}<ArrowRight size={12} /></a>)}</div></div>
      <div className="guide-hero-visual" aria-label="Základná cesta prichádzajúceho hovoru"><div className="guide-route-orbit" /><div className="guide-route-card"><div className="guide-route-card-top"><span className="guide-route-icon"><Phone size={20} /></span><span>Každý hovor<br /><strong>má svoj postup</strong></span><span className="guide-route-signal"><i /><i /><i /></span></div><ol>{[["Telefónne číslo", "Kam zákazník volá"], ["Plán zvonenia", "V akom poradí sa zvoní"], ["Skupina", "Komu sa hovor ponúkne"], ["Dostupný operátor", "Kto môže hovor prijať"]].map(([title, subtitle], index) => <li key={title}><span>{index === 3 ? <Check size={15} /> : index + 1}</span><div><strong>{title}</strong><small>{subtitle}</small></div></li>)}</ol><ChapterLink slug="cesta-hovoru" chapters={chapters} paths={paths}>Ako to spolu funguje</ChapterLink></div><span className="guide-route-note"><CheckCircle2 size={15} />Zrozumiteľné aj bez skúseností</span></div>
    </section>
    <section className="guide-paths" aria-labelledby="guide-paths-title"><div className="guide-section-heading"><div><span className="guide-eyebrow">DOBRÝ ZAČIATOK</span><h2 id="guide-paths-title">Vyberte si svoju cestu</h2></div><p>Začnite tým, čo práve potrebujete.</p></div><div className="guide-path-grid"><div className="guide-path-card"><span className="guide-path-icon"><Headphones size={23} /></span><div><span className="guide-kicker">PRE DISPEČERA</span><h3>Moja prvá služba</h3><p>Pripravte pracovisko, prijmite hovor a zaznamenajte pomoc zákazníkovi.</p><ol>{["prihlasenie", "priprava-na-sluzbu", "prijatie-a-zacatie-hovoru", "pripad"].map((slug, index) => <li key={slug}><span>{index + 1}</span><ChapterLink slug={slug} chapters={chapters} paths={paths} /></li>)}</ol></div></div><div className="guide-path-card guide-path-card--yellow"><span className="guide-path-icon"><Settings2 size={23} /></span><div><span className="guide-kicker">PRE VEDÚCEHO</span><h3>Nastavujem telefonovanie</h3><p>Pochopte súvislosti a zostavte jasný postup aj pre neprijatý hovor.</p><ol>{["cesta-hovoru", "skupiny-zvonenia", "plany-zvonenia", "cisla-hodiny-a-ivr"].map((slug, index) => <li key={slug}><span>{index + 1}</span><ChapterLink slug={slug} chapters={chapters} paths={paths} /></li>)}</ol></div></div></div></section>
    <section className="guide-categories" aria-labelledby="guide-categories-title"><div className="guide-section-heading"><div><span className="guide-eyebrow">CELÝ NÁVOD NA JEDNOM MIESTE</span><h2 id="guide-categories-title">Čo potrebujete zvládnuť?</h2></div><span className="guide-count">{chapters.length} kapitol · {categories.length} oblastí</span></div><div className="guide-category-grid">{categories.map((category, index) => {
      const Icon = categoryIcons[category.icon];
      const items = chapters.filter((chapter) => chapter.categoryId === category.id);
      return <section className="guide-category-card" id={category.id} key={category.id}><div className="guide-category-card-top"><span className="guide-category-icon"><Icon size={23} /></span><span className="guide-category-number">0{index + 1}</span></div><h3>{category.title}</h3><p>{category.description}</p><ul>{items.map((item) => <li key={item.slug}><a href={chapterHref(paths, item.slug)}>{item.title}<ChevronRight size={15} /></a></li>)}</ul><span className="guide-category-meta">{items.length} {items.length < 5 ? "kapitoly" : "kapitol"}</span></section>;
    })}</div></section>
    <aside className="guide-help-band"><span className="guide-help-band-icon"><Wrench size={25} /></span><div><h2>Telefón nezvoní? Niečo sa neuložilo?</h2><p>Najčastejšie situácie majú vlastný postup. Začnite jednoduchou kontrolou.</p></div><ChapterLink className="guide-button" slug="riesenie-problemov" chapters={chapters} paths={paths}>Riešenie problémov</ChapterLink></aside>
  </div>;
}

function ArticleSection({ section, index, screenshots, paths }: { section: GuideSection; index: number; screenshots: GuideScreenshot[]; paths: Paths }) {
  return <section className="guide-article-section" id={section.id}>
    <div className="guide-article-section-title"><span className="guide-section-number">{String(index + 1).padStart(2, "0")}</span><h2>{section.title}</h2><a className="guide-section-anchor" href={`#${section.id}`} aria-label={`Odkaz na časť ${section.title}`}>#</a><CopyLink anchor={section.id} compact /></div>
    {section.paragraphs?.map((paragraph, index) => <p key={index}>{paragraph}</p>)}
    {section.flow && <ol className="guide-flow" aria-label={`Postup: ${section.title}`}>{section.flow.map((item, index) => <li key={index}><span className="guide-flow-number">{index + 1}</span><span>{item}</span>{index < section.flow!.length - 1 && <ArrowRight size={17} className="guide-flow-arrow" aria-hidden="true" />}</li>)}</ol>}
    {section.steps && <ol className="guide-steps">{section.steps.map((step, index) => <li id={step.id} key={step.id}><span className="guide-step-number">{index + 1}</span><div><h3><a href={`#${step.id}`}>{step.title}</a></h3><p>{step.text}</p>{step.result && <p className="guide-step-result"><CheckCircle2 size={16} /><span>{step.result}</span></p>}</div></li>)}</ol>}
    {section.bullets && <ul className="guide-bullets">{section.bullets.map((bullet, index) => <li key={index}>{bullet}</li>)}</ul>}
    {section.table && <div className="guide-table-wrap" role="region" aria-label={`Tabuľka: ${section.title}`} tabIndex={0}><table><thead><tr>{section.table.headers.map((header, index) => <th key={index} scope="col">{header}</th>)}</tr></thead><tbody>{section.table.rows.map((row, index) => <tr key={index}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>)}</tbody></table></div>}
    {section.note && <aside className={`guide-callout guide-callout--${section.note.tone}`}><span className="guide-callout-icon">{section.note.tone === "important" ? <ShieldCheck size={21} /> : <Info size={21} />}</span><div><strong>{section.note.title}</strong><p>{section.note.text}</p></div></aside>}
    {section.screenshotIds?.map((id) => {
      const screenshot = screenshots.find((item) => item.id === id);
      return screenshot ? <AnnotatedScreenshot key={id} screenshot={screenshot} paths={paths} /> : null;
    })}
  </section>;
}

function ArticleContent({ chapter, chapters, categories, screenshots, paths }: { chapter: GuideChapter; chapters: GuideChapter[]; categories: GuideCategory[]; screenshots: GuideScreenshot[]; paths: Paths }) {
  const category = categories.find((item) => item.id === chapter.categoryId);
  const index = chapters.findIndex((item) => item.slug === chapter.slug);
  const previous = chapters[index - 1];
  const next = chapters[index + 1];
  return <div className="guide-reading-layout"><article className="guide-article"><header className="guide-article-header"><a className="guide-back" href={`${homeHref(paths)}#${category?.id ?? ""}`}><ArrowLeft size={15} />{category?.title ?? "Prehľad návodu"}</a><h1>{chapter.title}</h1><p className="guide-article-description">{chapter.description}</p><div className="guide-article-meta"><span><Users size={15} />{audienceNames[chapter.audience]}</span><span><Clock3 size={15} />{chapter.minutes} min čítania</span><CopyLink /></div></header>
    <details className="guide-mobile-toc"><summary><List size={18} />V tejto kapitole<ChevronDown size={16} /></summary><ol>{chapter.sections.map((section) => <li key={section.id}><a href={`#${section.id}`}>{section.title}</a></li>)}</ol></details>
    {!!chapter.prerequisites.length && <aside className="guide-prerequisites"><span className="guide-prerequisite-icon"><CheckCircle2 size={20} /></span><div><h2>Skôr než začnete</h2><ul>{chapter.prerequisites.map((item, index) => <li key={index}>{item}</li>)}</ul></div></aside>}
    {chapter.sections.map((section, sectionIndex) => <ArticleSection key={section.id} section={section} index={sectionIndex} screenshots={screenshots} paths={paths} />)}
    {!!chapter.related.length && <aside className="guide-related"><span className="guide-eyebrow">NADVIAŽTE NA TÚTO KAPITOLU</span><h2>Užitočné súvislosti</h2><div>{chapter.related.map((slug) => <ChapterLink key={slug} slug={slug} chapters={chapters} paths={paths} />)}</div></aside>}
    <nav className="guide-chapter-pagination" aria-label="Predchádzajúca a nasledujúca kapitola">{previous ? <a href={chapterHref(paths, previous.slug)}><ArrowLeft size={18} /><span><small>Predchádzajúca kapitola</small><strong>{previous.title}</strong></span></a> : <span />}{next && <a href={chapterHref(paths, next.slug)}><span><small>Ďalšia kapitola</small><strong>{next.title}</strong></span><ArrowRight size={18} /></a>}</nav>
  </article><aside className="guide-toc"><div><span className="guide-eyebrow">V TEJTO KAPITOLE</span><nav aria-label="Obsah tejto kapitoly"><ol>{chapter.sections.map((section, index) => <li key={section.id}><a href={`#${section.id}`}><span>{String(index + 1).padStart(2, "0")}</span>{section.title}</a></li>)}</ol></nav><a className="guide-toc-back" href="#guide-main"><ArrowDown size={14} />Späť na začiatok</a></div><div className="guide-toc-tip"><BookOpen size={19} /><strong>Čítajte aj obrázky</strong><p>Číslované značky vám ukážu, kde jednotlivé prvky nájdete. Obrázok si môžete zväčšiť.</p></div></aside></div>;
}

export function GuideView({ chapter, chapters, categories, screenshots, updatedAt, version, basePath = "/navod", assetBasePath = "/guide-assets", linkSuffix = "" }: GuideViewProps) {
  const paths = { basePath: basePath.replace(/\/$/, ""), assetBasePath: assetBasePath.replace(/\/$/, ""), linkSuffix };
  const drawer = useRef<HTMLDialogElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const category = categories.find((item) => item.id === chapter?.categoryId);
  const date = /^\d{4}-\d{2}-\d{2}/.test(updatedAt) ? updatedAt.slice(0, 10).split("-").reverse().map(Number).join(". ") : updatedAt;
  function closeDrawer() { drawer.current?.close(); menuButton.current?.focus(); }
  return <div className="guide"><a className="guide-skip" href="#guide-main">Prejsť na obsah</a><aside className="guide-sidebar"><Sidebar chapter={chapter} chapters={chapters} categories={categories} paths={paths} /></aside>
    <dialog className="guide-drawer" ref={drawer} aria-label="Navigácia návodu" onCancel={() => menuButton.current?.focus()} onClick={(event) => { if (event.target === drawer.current) closeDrawer(); }}><button className="guide-drawer-close" type="button" onClick={closeDrawer} aria-label="Zavrieť navigáciu"><X size={23} /></button><Sidebar chapter={chapter} chapters={chapters} categories={categories} paths={paths} onNavigate={() => drawer.current?.close()} /></dialog>
    <div className="guide-workspace"><header className="guide-topbar"><div className="guide-topbar-location"><button className="guide-mobile-menu" ref={menuButton} type="button" onClick={() => drawer.current?.showModal()} aria-label="Otvoriť navigáciu návodu"><Menu size={22} /></button><nav className="guide-breadcrumbs" aria-label="Drobčeková navigácia"><a href={homeHref(paths)}><BookOpen size={16} /><span>Návod</span></a>{chapter && <><ChevronRight size={13} /><a href={`${homeHref(paths)}#${category?.id ?? ""}`}>{category?.title}</a></>}</nav></div>{chapter ? <GuideSearch chapters={chapters} paths={paths} compact /> : <span className="guide-topbar-caption"><span className="guide-status-dot" />Všetko pre pokojnejšiu službu</span>}</header><main id="guide-main" tabIndex={-1}>{chapter ? <ArticleContent chapter={chapter} chapters={chapters} categories={categories} screenshots={screenshots} paths={paths} /> : <HomeContent chapters={chapters} categories={categories} paths={paths} />}</main><footer className="guide-footer"><a href={homeHref(paths)}><Headphones size={17} />Linka pomoci<span>·</span>Príručka dispečera</a><span>Aktualizované {date}<span className="guide-footer-separator">·</span>Vydanie {version}</span></footer></div>
  </div>;
}
