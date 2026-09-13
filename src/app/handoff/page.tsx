import type { Metadata } from "next";
import { HandoffRecipient } from "@/components/dispatch/HandoffRecipient";
export const metadata: Metadata = { title: "Odovzdanie prípadu", robots: { index: false, follow: false }, referrer: "no-referrer" };
export default function HandoffPage() { return <HandoffRecipient />; }
