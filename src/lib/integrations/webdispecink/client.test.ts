import { describe, expect, it } from "vitest";
import { parseWebdispecinkCars, parseWebdispecinkPositions } from "./client";

describe("WebDispecink SOAP parsers", () => {
  it("normalizes car catalog rows", () => {
    const cars = parseWebdispecinkCars(`
      <SOAP-ENV:Envelope>
        <SOAP-ENV:Body>
          <item>
            <carid>123</carid>
            <identifikator> za-842pm </identifikator>
            <driver>Ján</driver>
            <online>1</online>
            <disabled>0</disabled>
            <unitname>Odťah</unitname>
            <odometerKm>12345.7</odometerKm>
          </item>
        </SOAP-ENV:Body>
      </SOAP-ENV:Envelope>
    `);

    expect(cars).toEqual([
      {
        externalId: "123",
        licensePlate: "ZA-842PM",
        driverName: "Ján",
        online: true,
        disabled: false,
        unitName: "Odťah",
        odometerKm: 12345.7,
        raw: {
          carid: "123",
          identifikator: "za-842pm",
          driver: "Ján",
          online: "1",
          disabled: "0",
          unitname: "Odťah",
          odometerKm: "12345.7",
        },
      },
    ]);
  });

  it("normalizes position rows without leaking SOAP details to callers", () => {
    const positions = parseWebdispecinkPositions(`
      <item>
        <carid>123</carid>
        <latitude>49,2233</latitude>
        <longitude>18.7394</longitude>
        <positiontime>2026-06-23T08:10:00+02:00</positiontime>
        <speed>42</speed>
        <Location_city>Žilina</Location_city>
      </item>
    `);

    expect(positions).toEqual([
      {
        externalId: "123",
        point: { lat: 49.2233, lng: 18.7394 },
        positionTime: "2026-06-23T06:10:00.000Z",
        speedKph: 42,
        addressCity: "Žilina",
        raw: {
          carid: "123",
          latitude: "49,2233",
          longitude: "18.7394",
          positiontime: "2026-06-23T08:10:00+02:00",
          speed: "42",
          Location_city: "Žilina",
        },
      },
    ]);
  });
});
