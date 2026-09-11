import { guideCategories, guideChapters, GUIDE_CONTENT_VERSION, GUIDE_UPDATED_AT } from "../../content/guide/chapters";
import screenshots from "../../content/guide/screenshots.json";
import type { GuideChapter, GuideScreenshot } from "../../content/guide/types";
import { GuideView, type GuidePaths } from "./GuideView";

const shared = { categories: guideCategories, chapters: guideChapters, screenshots: screenshots as GuideScreenshot[], updatedAt: GUIDE_UPDATED_AT, version: GUIDE_CONTENT_VERSION };

export function GuideHome(props: GuidePaths = {}) {
  return <GuideView {...shared} {...props} />;
}

export function GuideArticle({ chapter, ...props }: GuidePaths & { chapter: GuideChapter }) {
  return <GuideView {...shared} {...props} chapter={chapter} />;
}

export type { GuidePaths } from "./GuideView";
