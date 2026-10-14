/**
 * Smoke test against the REAL OpenF1 API. Run: npm run smoke
 * It uses the 2025 São Paulo GP race.
 */
import { OpenF1Client } from "../src/client.js";
import { findEndpoint } from "../src/endpoints.js";
import { compareFastestLaps, raceSummary, runEndpointQuery, tyreStrategy } from "../src/tools.js";

const client = new OpenF1Client();
const step = async (name: string, fn: () => Promise<unknown>) => {
  const t = Date.now();
  try {
    const out = await fn();
    console.log(`OK   ${name} (${Date.now() - t} ms)\n     ${JSON.stringify(out).slice(0, 300)}…`);
    return out;
  } catch (err) {
    console.log(`FAIL ${name}: ${(err as Error).message}`);
    process.exitCode = 1;
    return undefined;
  }
};

const sessions = (await step("get_sessions", () =>
  runEndpointQuery(client, findEndpoint("sessions"), { year: 2025, country_name: "Brazil", session_name: "Race" }),
)) as { records: { session_key: number }[] } | undefined;

const sessionKey = sessions?.records[0]?.session_key;
if (!sessionKey) {
  console.log("No session found. Stop.");
  process.exit(1);
}

const summary = (await step("get_race_summary", () => raceSummary(client, sessionKey))) as
  | { standings?: { driver_number: number }[] }
  | undefined;
const top = summary?.standings?.slice(0, 3).map((s) => s.driver_number) ?? [];

await step("get_tyre_strategy", () => tyreStrategy(client, sessionKey, top));
if (top.length >= 2) await step("compare_fastest_laps", () => compareFastestLaps(client, sessionKey, top));
if (top[0]) {
  await step("get_car_data (lap 10)", () =>
    runEndpointQuery(client, findEndpoint("car_data"), { session_key: sessionKey, driver_number: top[0], lap_number: 10, limit: 20 }),
  );
}
await step("get_race_control (Safety car)", () =>
  runEndpointQuery(client, findEndpoint("race_control"), { session_key: sessionKey, category: "SafetyCar" }),
);
await step("get_weather (fields + filter)", () =>
  runEndpointQuery(client, findEndpoint("weather"), {
    session_key: sessionKey,
    fields: ["date", "track_temperature", "rainfall"],
    filters: [{ field: "track_temperature", op: ">=", value: 30 }],
    limit: 5,
  }),
);
