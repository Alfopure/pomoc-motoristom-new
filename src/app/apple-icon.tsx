import { ImageResponse } from "next/og";

export const size = {
  width: 180,
  height: 180,
};

export const contentType = "image/png";

export default function AppleIcon() {
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
            borderRadius: 40,
            color: "#09090b",
            display: "flex",
            fontSize: 54,
            fontWeight: 900,
            height: 124,
            justifyContent: "center",
            letterSpacing: 0,
            width: 124,
          }}
        >
          PM
        </div>
      </div>
    ),
    size,
  );
}
