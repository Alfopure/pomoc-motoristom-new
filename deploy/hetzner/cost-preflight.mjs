#!/usr/bin/env node
import { EXPECTED, getCostPreflight } from "./lib.mjs";

const result = await getCostPreflight();
console.log(
  JSON.stringify(
    {
      ok: true,
      target: `${EXPECTED.serverType}/${EXPECTED.location}`,
      backups: true,
      monthlyGrossEur: Number(result.totalGross.toFixed(2)),
      conservative27PercentVatEur: Number(result.conservativeGross.toFixed(2)),
      accountVatRatePercent: result.vatRate,
      includedTrafficBytes: result.includedTrafficBytes,
      additionalTrafficGrossPerTbEur: result.trafficGrossPerTb,
      existing: result.existing,
      inventory: result.inventory,
    },
    null,
    2,
  ),
);
