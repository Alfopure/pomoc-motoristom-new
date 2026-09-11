/** Shared source contract for the HTML guide, standalone export and future AI retrieval. */
export type GuideAudience = "all" | "manager" | "admin";

export type GuideStep = {
  id: string;
  title: string;
  text: string;
  result?: string;
};

export type GuideSection = {
  id: string;
  title: string;
  paragraphs?: string[];
  steps?: GuideStep[];
  bullets?: string[];
  note?: { tone: "info" | "important"; title: string; text: string };
  table?: { headers: string[]; rows: string[][] };
  screenshotIds?: string[];
  flow?: string[];
};

export type GuideChapter = {
  slug: string;
  title: string;
  description: string;
  categoryId: string;
  audience: GuideAudience;
  minutes: number;
  keywords: string[];
  prerequisites: string[];
  sections: GuideSection[];
  related: string[];
  /** Repository references for editorial checks; not a substitute for live verification. */
  sources: string[];
};

export type GuideCategory = {
  id: string;
  title: string;
  description: string;
  icon: "start" | "phone" | "cases" | "settings" | "team" | "help";
};

export type GuideAnnotation = {
  id: string;
  label: string;
  /** Percent coordinates relative to the unmodified captured image. */
  x: number;
  y: number;
  width: number;
  height: number;
};

export type GuideScreenshot = {
  id: string;
  file: string;
  title: string;
  alt: string;
  width: number;
  height: number;
  annotations: GuideAnnotation[];
  scenario: string;
  capturedAt: string;
  sourceRevision: string;
};
