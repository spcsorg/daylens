import type { Metadata, Viewport } from "next";
import { Archivo } from "next/font/google";
import { assetPath } from "@/app/lib/basePath";
import { SITE_DESCRIPTION, SITE_TITLE, SITE_URL } from "./_lib/site";
import "./site.css";

const archivo = Archivo({
  subsets: ["latin"],
  axes: ["wdth"],
  display: "swap",
  variable: "--font-archivo",
});

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: SITE_TITLE,
    template: "%s · Daylens",
  },
  description: SITE_DESCRIPTION,
  applicationName: "Daylens",
  icons: {
    icon: [{ url: assetPath("/app-icon.png"), type: "image/png" }],
    apple: [{ url: assetPath("/app-icon.png"), type: "image/png" }],
  },
  alternates: {
    types: {
      "application/rss+xml": [{ url: assetPath("/devlog/rss.xml"), title: "Daylens devlog" }],
    },
  },
  openGraph: {
    type: "website",
    siteName: "Daylens",
    locale: "en",
  },
  twitter: {
    card: "summary_large_image",
  },
};

export const viewport: Viewport = {
  themeColor: "#f3f5f4",
  colorScheme: "light",
  width: "device-width",
  initialScale: 1,
};

export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={archivo.variable}>
      <body className="site">{children}</body>
    </html>
  );
}
