import type { Metadata, Viewport } from "next";
import { Geist, Inter } from "next/font/google";
import { pageMetadata, SiteSchema } from "../_v2/meta";
import "./beam.css";

// Beam sets type in system-ui (SF Pro on Apple). Inter with optical sizing is the closest free match.
const inter = Inter({ subsets: ["latin"], axes: ["opsz"], display: "swap", variable: "--font-inter" });
// App UI font, only for the HTML recreation of the search screen.
const geist = Geist({ subsets: ["latin"], weight: ["400", "500"], display: "swap", variable: "--font-geist", preload: false });

export const metadata: Metadata = pageMetadata("beam");

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#171717" },
  ],
};

const THEME = `(function(){var r=document.documentElement;r.classList.add('b-js');try{var t=localStorage.getItem('daylens-beam-theme');var d=t==='dark'||(!t&&matchMedia('(prefers-color-scheme: dark)').matches);r.classList.toggle('dark',d)}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${geist.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME }} />
      </head>
      <body>
        <SiteSchema />
        {children}
      </body>
    </html>
  );
}
