import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import { MotionProvider } from "../_components/Motion";
import { SITE } from "../_lib/content";
import "../globals.css";

const geist = Geist({ subsets: ["latin"], display: "swap", variable: "--font-geist" });

export const metadata: Metadata = {
  title: SITE.title,
  description: SITE.description,
  applicationName: "Daylens",
  icons: { icon: "/icons/daylens.png", apple: "/icons/daylens.png" },
  openGraph: {
    type: "website",
    siteName: "Daylens",
    title: SITE.title,
    description: SITE.description,
    images: [{ url: "/screens/today-hour-open-window.png", width: 2244, height: 1444 }],
  },
  twitter: { card: "summary_large_image" },
};

export const viewport: Viewport = {
  themeColor: "#fafaf7",
  colorScheme: "light",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={geist.variable}>
      <body>
        <MotionProvider>{children}</MotionProvider>
      </body>
    </html>
  );
}
