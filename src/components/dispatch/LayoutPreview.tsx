"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { LayoutPreviewMode } from "./layout-preview-policy";

const PreviewContext = createContext<{ enabled: boolean; mode: LayoutPreviewMode }>({ enabled: false, mode: "classic" });

/**
 * The appearance, decided once by the deployment.
 *
 * It used to be a per-browser choice with a toolbar above the console to
 * switch it, because both looks were being tried at the same time. That trial
 * is over: a strip across the top of every screen asking which appearance you
 * would like is not something an operator taking calls should have to read.
 */
export function LayoutPreviewProvider({ enabled, mode, children }: { enabled: boolean; actorKey?: string; mode?: LayoutPreviewMode; children: ReactNode }) {
  // `mode` is for the visual fixtures, which exist to put both appearances
  // side by side. Nothing in the console passes it.
  return <PreviewContext.Provider value={{ enabled, mode: mode ?? (enabled ? "modern" : "classic") }}>{children}</PreviewContext.Provider>;
}

export const useLayoutPreview = () => useContext(PreviewContext);
