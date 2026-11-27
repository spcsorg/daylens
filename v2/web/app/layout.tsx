import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = { title: "Daylens Enterprise" };

const THEME = `(() => { const m = matchMedia("(prefers-color-scheme: dark)"); const set = () => document.documentElement.dataset.theme = m.matches ? "dark" : "light"; set(); m.addEventListener("change", set); })()`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en-GB" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
