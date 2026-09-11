import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { guideCategories, guideChapters, GUIDE_CONTENT_VERSION, GUIDE_UPDATED_AT } from "./chapters";
import images from "./screenshots.json";
import { buildGuideKnowledge } from "./knowledge";

describe("client guide publishing integrity", () => {
  it("has unique stable chapter/step addresses, valid cross-links and existing illustration files", () => {
    const slugs = new Set(guideChapters.map(chapter => chapter.slug));
    const categoryIds = new Set(guideCategories.map(category => category.id));
    const screenshotIds = new Set(images.map(image => image.id));
    expect(slugs.size).toBe(guideChapters.length);
    expect(screenshotIds.size).toBe(images.length);
    expect(guideChapters.length).toBeGreaterThanOrEqual(23);
    for (const chapter of guideChapters) {
      expect(categoryIds.has(chapter.categoryId), chapter.slug).toBe(true);
      const anchors = chapter.sections.flatMap(section => [section.id, ...(section.steps ?? []).map(step => step.id)]);
      expect(new Set(anchors).size, chapter.slug).toBe(anchors.length);
      expect(anchors.every(anchor => /^[a-z0-9-]+$/.test(anchor)), chapter.slug).toBe(true);
      for (const target of chapter.related) expect(slugs.has(target), `${chapter.slug} → ${target}`).toBe(true);
      for (const section of chapter.sections) {
        for (const id of section.screenshotIds ?? []) expect(screenshotIds.has(id), `${chapter.slug} screenshot ${id}`).toBe(true);
      }
    }
    for (const image of images) {
      expect(existsSync(path.resolve("public/guide-assets", image.file)), image.file).toBe(true);
      expect(image.width).toBeGreaterThan(0);
      expect(image.height).toBeGreaterThan(0);
      expect(image.annotations.length, image.id).toBeLessThanOrEqual(3);
      for (const mark of image.annotations) {
        expect(mark.x).toBeGreaterThanOrEqual(0);
        expect(mark.y).toBeGreaterThanOrEqual(0);
        expect(mark.width).toBeGreaterThan(0);
        expect(mark.height).toBeGreaterThan(0);
        expect(mark.x + mark.width, `${image.id}/${mark.id}`).toBeLessThanOrEqual(100.1);
        expect(mark.y + mark.height, `${image.id}/${mark.id}`).toBeLessThanOrEqual(100.1);
      }
    }
  });
  it("preserves visible content and annotation meaning in citation-sized AI records", () => {
    const exportData = buildGuideKnowledge(guideChapters, images, { version: GUIDE_CONTENT_VERSION, updatedAt: GUIDE_UPDATED_AT, sourceRevision: "test" });
    for (const chapter of guideChapters) {
      for (const section of chapter.sections) {
        const record = exportData.records.find(item => item.id === `${chapter.slug}#${section.id}`)!;
        expect(record).toBeDefined();
        for (const paragraph of section.paragraphs ?? []) expect(record.text).toContain(paragraph);
        for (const step of section.steps ?? []) {
          expect(record.text).toContain(step.text);
          expect(record.steps.find(item => item.id === step.id)?.url).toBe(`/navod/${chapter.slug}#${step.id}`);
        }
        for (const image of record.images) for (const annotation of image.annotations) expect(record.text).toContain(annotation.label);
      }
    }
  });
});
