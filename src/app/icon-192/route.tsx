import { ImageResponse } from "next/og";

export const dynamic = "force-static";

export function GET() {
  return new ImageResponse(
    (
      <div
        style={{
          alignItems: "center",
          background: "#09090b",
          display: "flex",
          height: "100%",
          justifyContent: "center",
          width: "100%",
        }}
      >
        <div
          style={{
            alignItems: "center",
            background: "#fcd703",
            borderRadius: 42,
            color: "#09090b",
            display: "flex",
            fontSize: 58,
            fontWeight: 900,
            height: 132,
            justifyContent: "center",
            width: 132,
          }}
        >
          PM
        </div>
      </div>
    ),
    { width: 192, height: 192 },
  );
}
