import type { Metadata, Viewport } from "next";
import { Raleway } from "next/font/google";
import { pageMetadata, SiteSchema } from "../_v2/meta";
import "./rize.css";

const raleway = Raleway({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
  variable: "--font-raleway",
});

export const metadata: Metadata = pageMetadata("rize");

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#080808" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={raleway.variable}>
      <body>
        <SiteSchema />
        {children}
      </body>
    </html>
  );
}
