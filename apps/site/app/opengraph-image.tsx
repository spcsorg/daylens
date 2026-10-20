import { ImageResponse } from "next/og";
import { COPY } from "./(launch)/_launch/content";

export const alt = "Daylens";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: 80, background: "#fafaf9", color: "#171717" }}>
        <div style={{ fontSize: 36, fontWeight: 600 }}>Daylens</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div style={{ fontSize: 72, fontWeight: 600, lineHeight: 1.05, letterSpacing: -2 }}>{COPY.title}</div>
          <div style={{ fontSize: 30, color: "#57534e", lineHeight: 1.35 }}>{COPY.sub}</div>
        </div>
      </div>
    ),
    size,
  );
}
