import type { Metadata, Viewport } from "next";
import { Instrument_Sans } from "next/font/google";
import { pageMetadata, SiteSchema } from "../_v2/meta";
import "./ramp.css";

// Ramp sets everything in Lausanne (paid). Instrument Sans is the closest free match on width and letter shapes.
const sans = Instrument_Sans({ subsets: ["latin"], weight: ["400", "500"], display: "swap", variable: "--font-sans" });

export const metadata: Metadata = pageMetadata("ramp");

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#f5f4f0" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={sans.variable}>
      <body>
        <SiteSchema />
        {children}
      </body>
    </html>
  );
}
