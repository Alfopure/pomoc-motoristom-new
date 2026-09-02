import type { Metadata, Viewport } from "next";
import { Poppins } from "next/font/google";
import Script from "next/script";
import { ServiceWorkerRegistration } from "@/components/pwa/ServiceWorkerRegistration";
import "./globals.css";

const poppins = Poppins({
  variable: "--font-poppins",
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500", "600", "700", "800"],
});

export const metadata: Metadata = {
  title: {
    default: "Pomoc Motoristom",
    template: "%s | Pomoc Motoristom",
  },
  description: "Mobilný dispečing pre linku pomoci motoristom, flotilu, mapu zásahu a ústredňu.",
  applicationName: "Pomoc Motoristom",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Pomoc Motoristom",
  },
  formatDetection: {
    telephone: false,
  },
  icons: {
    icon: "/icon",
    apple: "/apple-icon",
  },
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = {
  themeColor: "#09090b",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="sk"
      className={`${poppins.variable} h-full antialiased`}
    >
      <body className="min-h-full bg-zinc-100">
        {process.env.NODE_ENV === "development" && <DevelopmentCacheReset />}
        {process.env.NODE_ENV === "production" && <ServiceWorkerRegistration />}
        {children}
      </body>
    </html>
  );
}

function DevelopmentCacheReset() {
  return (
    <Script id="development-cache-reset" strategy="beforeInteractive">
      {`
          (function () {
            if (!("serviceWorker" in navigator)) return;
            var reloadKey = "pm-dev-sw-cleaned-v1";
            Promise.all([
              navigator.serviceWorker.getRegistrations().then(function (registrations) {
                return Promise.all(registrations.map(function (registration) {
                  return registration.unregister();
                }));
              }),
              "caches" in window
                ? caches.keys().then(function (keys) {
                    return Promise.all(keys.map(function (key) {
                      return caches.delete(key);
                    }));
                  })
                : Promise.resolve()
            ]).then(function () {
              if (navigator.serviceWorker.controller && !sessionStorage.getItem(reloadKey)) {
                sessionStorage.setItem(reloadKey, "1");
                window.location.reload();
              }
            }).catch(function () {});
          })();
      `}
    </Script>
  );
}
