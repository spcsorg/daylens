import type { Metadata, Viewport } from "next";
import { Funnel_Sans, Geist } from "next/font/google";
import { pageMetadata, SiteSchema } from "../_v2/meta";
import "./toggl.css";

const brand = Funnel_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], display: "swap", variable: "--font-brand" });
const app = Geist({ subsets: ["latin"], weight: ["400", "500", "600"], display: "swap", variable: "--font-app" });

export const metadata: Metadata = pageMetadata("toggl");

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#f8f7f1" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${brand.variable} ${app.variable}`}>
      <body>
        <SiteSchema />
        {children}
      </body>
    </html>
  );
}
