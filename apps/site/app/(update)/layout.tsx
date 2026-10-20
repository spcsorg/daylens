import type { Metadata, Viewport } from "next";
import { Geist_Mono, Instrument_Sans } from "next/font/google";
import { pageMetadata, SiteSchema } from "../_v2/meta";
import "./update.css";

const sans = Instrument_Sans({ subsets: ["latin"], weight: ["400", "600"], display: "swap", variable: "--font-sans" });
const mono = Geist_Mono({ subsets: ["latin"], weight: ["400"], display: "swap", variable: "--font-mono" });

export const metadata: Metadata = pageMetadata("update");

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
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <SiteSchema />
        {children}
      </body>
    </html>
  );
}
