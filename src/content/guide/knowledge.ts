import type { GuideChapter, GuideScreenshot } from "./types";

export type GuideKnowledgeOptions = {
  version: string;
  updatedAt: string;
  sourceRevision: string;
};

/** Build citation-sized records from exactly the content shown in the guide.
 * This is documentation only: no live configuration, profile or telephony read.
 */
export function buildGuideKnowledge(chapters: GuideChapter[], screenshots: GuideScreenshot[], options: GuideKnowledgeOptions) {
  const images = new Map(screenshots.map(image => [image.id, image]));
  return {
    schemaVersion: 1,
    contentVersion: options.version,
    updatedAt: options.updatedAt,
    verification: { sourceRevision: options.sourceRevision, method: "source-code-and-isolated-ui", liveTelephonyVerified: false },
    dataKind: "documentation",
    language: "sk",
    records: chapters.flatMap(chapter => chapter.sections.map(section => {
      const sectionImages = (section.screenshotIds ?? []).flatMap(id => {
        const image = images.get(id);
        return image ? [{ id: image.id, alt: image.alt, title: image.title, annotations: image.annotations }] : [];
      });
      const text = [
        chapter.description,
        ...chapter.prerequisites,
        ...(section.paragraphs ?? []),
        ...(section.steps ?? []).flatMap(step => [step.title, step.text, step.result ?? ""]),
        ...(section.bullets ?? []),
        ...(section.flow ?? []),
        ...(section.note ? [section.note.title, section.note.text] : []),
        ...(section.table ? [section.table.headers.join(" | "), ...section.table.rows.map(row => row.join(" | "))] : []),
        ...sectionImages.flatMap(image => [image.alt, ...image.annotations.map(annotation => annotation.label)]),
      ].filter(Boolean).join("\n\n");
      return {
        id: `${chapter.slug}#${section.id}`,
        url: `/navod/${chapter.slug}#${section.id}`,
        title: `${chapter.title} — ${section.title}`,
        chapterSlug: chapter.slug,
        categoryId: chapter.categoryId,
        audience: chapter.audience,
        keywords: chapter.keywords,
        prerequisites: chapter.prerequisites,
        text,
        steps: (section.steps ?? []).map(step => ({ ...step, url: `/navod/${chapter.slug}#${step.id}` })),
        images: sectionImages,
        related: chapter.related.map(slug => `/navod/${slug}`),
      };
    })),
  };
}
