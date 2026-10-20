import type { Metadata, Viewport } from "next";
import { Geist, IBM_Plex_Mono } from "next/font/google";
import { pageMetadata, SiteSchema } from "../_v2/meta";
import "./superlogical.css";

const sans = Geist({ subsets: ["latin"], weight: ["400", "600"], display: "swap", variable: "--font-sans" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400"], display: "swap", variable: "--font-mono", preload: false });

export const metadata: Metadata = pageMetadata("superlogical");

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f5f4" },
    { media: "(prefers-color-scheme: dark)", color: "#10120f" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} sl-html`}>
      <body>
        <SiteSchema />
        {children}
      </body>
    </html>
  );
}
