import { renderToString } from "react-dom/server";
import { GuideArticle, GuideHome } from "../../src/components/guide";
import { guideChapters, GUIDE_CONTENT_VERSION, GUIDE_UPDATED_AT, GUIDE_SOURCE_REVISION } from "../../src/content/guide/chapters";
import screenshots from "../../src/content/guide/screenshots.json";
import { buildGuideKnowledge } from "../../src/content/guide/knowledge";

const paths = { basePath: ".", assetBasePath: "./guide-assets", linkSuffix: ".html" };
export const pages = [{ slug: "index", title: "Návod k dispečingu" }, ...guideChapters.map(({ slug, title }) => ({ slug, title }))];
export const knowledge = buildGuideKnowledge(guideChapters, screenshots, { version: GUIDE_CONTENT_VERSION, updatedAt: GUIDE_UPDATED_AT, sourceRevision: GUIDE_SOURCE_REVISION });

export function renderGuide(slug: string) {
  if (slug === "index") return renderToString(<GuideHome {...paths} />);
  const chapter = guideChapters.find(item => item.slug === slug);
  if (!chapter) throw new Error(`Unknown guide chapter: ${slug}`);
  return renderToString(<GuideArticle chapter={chapter} {...paths} />);
}
