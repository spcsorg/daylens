import type { Metadata, Viewport } from "next";
import { Figtree } from "next/font/google";
import { pageMetadata, SiteSchema } from "../_v2/meta";
import "./chatgpt.css";

const figtree = Figtree({ subsets: ["latin"], weight: ["400", "500", "600"], display: "swap", variable: "--font-figtree" });

export const metadata: Metadata = pageMetadata("chatgpt");

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

// Runs before paint so a stored or system dark theme never flashes light.
const THEME_SCRIPT = `try{var t=localStorage.getItem("theme");var d=t?t==="dark":matchMedia("(prefers-color-scheme: dark)").matches;var e=document.documentElement;e.classList.toggle("dark",d);e.dataset.theme=d?"dark":"light"}catch(_){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={figtree.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <SiteSchema />
        {children}
      </body>
    </html>
  );
}
