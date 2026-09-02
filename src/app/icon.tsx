import { ImageResponse } from "next/og";

export const size = {
  width: 512,
  height: 512,
};

export const contentType = "image/png";

export default function Icon() {
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
            borderRadius: 112,
            color: "#09090b",
            display: "flex",
            fontSize: 156,
            fontWeight: 900,
            height: 352,
            justifyContent: "center",
            letterSpacing: 0,
            width: 352,
          }}
        >
          PM
        </div>
      </div>
    ),
    size,
  );
}
