import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { pageMetadata, SiteSchema } from "../_v2/meta";
import "./launch.css";

const sans = Geist({ subsets: ["latin"], weight: ["400", "500", "600"], display: "swap", variable: "--font-sans" });
// Only the raw activity lines use it: they are what the computer reported, verbatim.
const mono = Geist_Mono({ subsets: ["latin"], weight: ["400"], display: "swap", variable: "--font-mono", preload: false });

export const metadata: Metadata = pageMetadata();

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
    <html lang="en" className={`${sans.variable} ${mono.variable} lx-html`}>
      <body>
        <SiteSchema />
        {children}
      </body>
    </html>
  );
}
