import { ImageResponse } from "next/og";

export const alt = "Daylens: find anything you saw on your computer. Pick up where you left off.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const TICKETS = [
  { number: 1, time: "7:00–8:00", title: "Answered the morning's cake orders" },
  { number: 2, time: "8:00–9:00", title: "Wrote the price list for the new sourdough" },
  { number: 3, time: "9:00–10:00", title: "Watched a video on pricing bread" },
];

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background: "#f3f5f4",
          color: "#17233a",
          padding: "64px 72px 0",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", fontSize: 34, fontWeight: 700, letterSpacing: -0.5 }}>Daylens</div>
        <div
          style={{
            display: "flex",
            marginTop: 28,
            fontSize: 70,
            fontWeight: 800,
            lineHeight: 1.02,
            letterSpacing: -2,
            maxWidth: 1000,
          }}
        >
          Find anything you saw on your computer. Pick up where you left off.
        </div>
        <div style={{ display: "flex", position: "relative", marginTop: 52, height: 220 }}>
          <div
            style={{
              position: "absolute",
              top: 10,
              left: -72,
              right: -72,
              height: 12,
              borderRadius: 6,
              background: "linear-gradient(180deg, #dfe4e6, #a7b0b5 45%, #6b757b)",
            }}
          />
          {TICKETS.map((ticket, index) => (
            <div
              key={ticket.number}
              style={{
                display: "flex",
                flexDirection: "column",
                width: 330,
                height: 220,
                marginRight: 24,
                padding: "30px 22px 0",
                background: "#eef5e8",
                borderRadius: 4,
                transform: `rotate(${[-0.8, 0.5, -0.3][index]}deg)`,
                boxShadow: "0 14px 24px -16px rgba(23,35,58,0.55)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  paddingBottom: 10,
                  borderBottom: "2px solid #b8302a",
                  fontSize: 20,
                }}
              >
                <span style={{ color: "#b8302a", fontWeight: 700 }}>No. {ticket.number}</span>
                <span style={{ color: "#46526a" }}>{ticket.time}</span>
              </div>
              <div style={{ display: "flex", marginTop: 14, fontSize: 28, fontWeight: 700, lineHeight: 1.15 }}>
                {ticket.title}
              </div>
            </div>
          ))}
        </div>
      </div>
    ),
    size,
  );
}
