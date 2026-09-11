import { hydrateRoot } from "react-dom/client";
import { GuideArticle, GuideHome } from "../../src/components/guide";
import { guideChapters } from "../../src/content/guide/chapters";

const root = document.getElementById("guide-root");
const data = document.getElementById("guide-page");
if (root && data) {
  const { slug } = JSON.parse(data.textContent ?? "{}");
  const paths = { basePath: ".", assetBasePath: "./guide-assets", linkSuffix: ".html" };
  const chapter = guideChapters.find(item => item.slug === slug);
  if (slug === "index") hydrateRoot(root, <GuideHome {...paths} />);
  else if (chapter) hydrateRoot(root, <GuideArticle chapter={chapter} {...paths} />);
}
