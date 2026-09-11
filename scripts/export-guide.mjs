#!/usr/bin/env node
import { build } from "esbuild";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";

// Produces a portable, fully local HTML site. No credentials or runtime data.
const project = process.cwd();
const outputDir = path.resolve(process.argv[2] || ".context/guide-standalone");
if (outputDir === project || !path.relative(project, outputDir)) throw new Error("Choose a dedicated guide output directory.");
const tempDir = path.join(project, ".context", "guide-export-build");
await mkdir(tempDir, { recursive: true });
await mkdir(outputDir, { recursive: true });

await build({
  entryPoints: ["scripts/guide/render.tsx"], outfile: path.join(tempDir, "render.mjs"),
  bundle: true, platform: "node", format: "esm", jsx: "automatic",
  packages: "external",
});
const { pages, renderGuide, knowledge } = await import(pathToFileURL(path.join(tempDir, "render.mjs")).href);
const client = await build({
  entryPoints: ["scripts/guide/client.tsx"], outfile: "guide.js", bundle: true, write: false,
  platform: "browser", format: "iife", jsx: "automatic", minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
});
for (const file of client.outputFiles) await writeFile(path.join(outputDir, path.basename(file.path)), file.contents);
const escapeHtml = value => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
for (const page of pages) {
  const html = `<!doctype html><html lang="sk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${escapeHtml(page.title)} | Pomoc motoristom</title><link rel="stylesheet" href="./guide.css"><style>body{margin:0}*,*::before,*::after{box-sizing:border-box}button,input{font:inherit}a{color:inherit}img{max-width:100%}</style></head><body><div id="guide-root">${renderGuide(page.slug)}</div><script id="guide-page" type="application/json">${JSON.stringify({ slug: page.slug }).replaceAll("<", "\\u003c")}</script><script src="./guide.js" defer></script></body></html>`;
  await writeFile(path.join(outputDir, `${page.slug}.html`), html);
}
await cp("public/guide-assets", path.join(outputDir, "guide-assets"), { recursive: true });
await writeFile(path.join(outputDir, "knowledge.json"), JSON.stringify(knowledge, null, 2));
await writeFile(path.join(outputDir, "README.txt"), "Návod k dispečingu Pomoc motoristom\n\nOtvorte index.html v prehliadači. Súbory ponechajte v jednom priečinku.\nNávod obsahuje ukážkové údaje, nečíta nastavenia organizácie a nevykonáva hovory.\nknowledge.json je spoločný textový zdroj pre budúce vyhľadávanie a AI pomocníka.\n");
console.log(`Exported ${pages.length} HTML pages and ${knowledge.records.length} documentation records to ${outputDir}`);
