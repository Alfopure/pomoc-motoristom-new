import type { GuideChapter } from "../../content/guide/types";

export type GuideSearchResult = {
  chapterSlug: string;
  chapterTitle: string;
  title: string;
  anchor?: string;
  excerpt: string;
  score: number;
};

export function normalizeGuideText(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("sk").replace(/[^a-z0-9]+/g, " ").trim();
}

const synonymGroups = [
  ["pauza", "pauzu", "pauze", "prestávka", "prestávku", "prestávke", "prestávky", "pauzy"],
  ["čakáreň", "čakárni", "čakárne", "fronta", "fronty", "fronte", "frontu"],
  ["callback", "spätné volanie", "spätný hovor", "spätné hovory"],
  ["zvonenie", "zvoní", "zvoniť", "vyzváňanie"],
  ["prihlásenie", "prihlásiť", "login"],
  ["heslo", "password"],
  ["stlmiť", "mikrofón", "mute"],
  ["presmerovanie", "prepojenie", "prepojiť", "transfer"],
].map((group) => group.map(normalizeGuideText));

const stopWords = new Set(["ako", "kde", "co", "preco", "je", "sa", "mi", "si", "som", "a", "na", "v", "vo", "do", "ked", "mam", "mozem", "chcem", "dam", "to", "ten", "ta", "tie", "the", "how"]);

function queryGroups(query: string): string[][] {
  const normalized = normalizeGuideText(query);
  const groups: string[][] = [];
  let remaining = normalized;
  for (const synonyms of synonymGroups) {
    const phrase = synonyms.find((word) => word.includes(" ") && (` ${remaining} `).includes(` ${word} `));
    if (phrase) {
      groups.push(synonyms);
      remaining = (` ${remaining} `).replace(` ${phrase} `, " ").trim();
    }
  }
  for (const word of remaining.split(/\s+/).filter((part) => part && !stopWords.has(part))) {
    groups.push(synonymGroups.find((synonyms) => synonyms.includes(word)) ?? [word]);
  }
  return groups;
}

function excerpt(text: string, groups: string[][]): string {
  const normalized = normalizeGuideText(text);
  const positions = groups.flat().map((term) => normalized.indexOf(term)).filter((position) => position >= 0);
  const start = positions.length ? Math.max(0, Math.min(...positions) - 48) : 0;
  const end = Math.min(text.length, start + 165);
  return `${start ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

/** Local-only full-text search; no query or document is sent to an external service. */
export function searchGuide(query: string, chapters: GuideChapter[], limit = 8): GuideSearchResult[] {
  const groups = queryGroups(query);
  if (!groups.length) return [];
  const results: GuideSearchResult[] = [];
  for (const chapter of chapters) {
    const candidates = [
      { title: chapter.title, text: [chapter.description, ...chapter.prerequisites, ...chapter.keywords].join(" "), anchor: undefined as string | undefined },
      ...chapter.sections.flatMap((section) => [
        {
          title: section.title,
          text: [...(section.paragraphs ?? []), ...(section.bullets ?? []), ...(section.flow ?? []), ...(section.table?.headers ?? []), ...(section.table?.rows.flat() ?? []), section.note?.title ?? "", section.note?.text ?? ""].join(" "),
          anchor: section.id,
        },
        ...(section.steps ?? []).map((step) => ({ title: step.title, text: `${step.text} ${step.result ?? ""}`, anchor: step.id })),
      ]),
    ];
    for (const candidate of candidates) {
      const title = normalizeGuideText(candidate.title);
      const body = normalizeGuideText(candidate.text);
      const context = normalizeGuideText(chapter.title);
      let score = 0;
      let matched = true;
      for (const group of groups) {
        const points = Math.max(...group.map((term) => title.includes(term) ? 12 : body.includes(term) ? 4 : context.includes(term) ? 1 : 0));
        if (!points) { matched = false; break; }
        score += points;
      }
      if (matched) results.push({ chapterSlug: chapter.slug, chapterTitle: chapter.title, title: candidate.title, anchor: candidate.anchor, excerpt: excerpt(candidate.text || chapter.description, groups), score: score + (title === normalizeGuideText(query) ? 20 : 0) });
    }
  }
  return results.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, "sk")).slice(0, limit);
}
