import type { Metadata } from "next";
import "./style.css";

export const metadata: Metadata = {
  title: "Testovanie · Pomoc motoristom",
  description:
    "Spoločné testovanie dispečingu. Scenáre, výsledky a história zmien na jednom mieste.",
  robots: { index: false, follow: false },
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="sk">
      <body>{children}</body>
    </html>
  );
}
