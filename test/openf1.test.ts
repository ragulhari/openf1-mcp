import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildQuery, OpenF1Client } from "../src/client.js";
import { findEndpoint } from "../src/endpoints.js";
import { shape } from "../src/shape.js";
import { compareFastestLaps, raceSummary, registerTools, runEndpointQuery, tyreStrategy } from "../src/tools.js";

// ---------- fake API ----------

type Handler = (url: URL) => { status: number; body: unknown; headers?: Record<string, string> };

function fakeFetch(handler: Handler) {
  const calls: string[] = [];
  const impl = (async (input: string | URL) => {
    const raw = String(input);
    calls.push(raw);
    const { status, body, headers } = handler(new URL(raw));
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  }) as typeof fetch;
  return { impl, calls };
}

const fixtures: Record<string, unknown[]> = {
  sessions: [{ session_key: 9999, session_name: "Race", location: "São Paulo", country_name: "Brazil", circuit_short_name: "Interlagos", date_start: "2025-11-09T17:00:00+00:00", year: 2025 }],
  drivers: [
    { driver_number: 1, name_acronym: "VER", full_name: "Max VERSTAPPEN", team_name: "Red Bull Racing" },
    { driver_number: 4, name_acronym: "NOR", full_name: "Lando NORRIS", team_name: "McLaren" },
    { driver_number: 81, name_acronym: "PIA", full_name: "Oscar PIASTRI", team_name: "McLaren" },
  ],
  session_result: [
    { driver_number: 81, position: 2, number_of_laps: 71, duration: 5400.5, gap_to_leader: 2.1, dnf: false, dns: false, dsq: false },
    { driver_number: 4, position: 1, number_of_laps: 71, duration: 5398.4, gap_to_leader: 0, dnf: false, dns: false, dsq: false },
    { driver_number: 1, position: null, number_of_laps: 30, duration: null, gap_to_leader: null, dnf: true, dns: false, dsq: false },
  ],
  starting_grid: [
    { driver_number: 4, position: 1 },
    { driver_number: 81, position: 4 },
    { driver_number: 1, position: 19 },
  ],
  stints: [
    { driver_number: 4, stint_number: 2, compound: "HARD", lap_start: 25, lap_end: 71, tyre_age_at_start: 0 },
    { driver_number: 4, stint_number: 1, compound: "MEDIUM", lap_start: 1, lap_end: 24, tyre_age_at_start: 0 },
  ],
  pit: [{ driver_number: 4, lap_number: 24, lane_duration: 21.9, stop_duration: 2.3 }],
  laps: [
    { driver_number: 4, lap_number: 10, lap_duration: 72.5, duration_sector_1: 18.1, duration_sector_2: 36.0, duration_sector_3: 18.4, is_pit_out_lap: false, date_start: "2025-11-09T17:15:00.000Z" },
    { driver_number: 4, lap_number: 11, lap_duration: 72.2, duration_sector_1: 18.2, duration_sector_2: 35.8, duration_sector_3: 18.2, is_pit_out_lap: false, date_start: "2025-11-09T17:16:12.500Z" },
    { driver_number: 4, lap_number: 25, lap_duration: 60.0, duration_sector_1: 10, duration_sector_2: 30, duration_sector_3: 20, is_pit_out_lap: true, date_start: "2025-11-09T17:40:00.000Z" },
    { driver_number: 81, lap_number: 10, lap_duration: 72.6, duration_sector_1: 18.0, duration_sector_2: 36.2, duration_sector_3: 18.4, is_pit_out_lap: false, date_start: "2025-11-09T17:15:01.000Z" },
  ],
};

/** Applies equality filters (incl. repeated params) like the real API. */
function api(url: URL) {
  const path = url.pathname.split("/").pop()!;
  const rows = (fixtures[path] ?? []) as Record<string, unknown>[];
  const eq = new Map<string, string[]>();
  for (const [k, v] of url.searchParams) if (!/[<>]/.test(k) && k !== "session_key" && k !== "meeting_key") eq.set(k, [...(eq.get(k) ?? []), v]);
  const out = rows.filter((r) => [...eq].every(([k, vs]) => vs.includes(String(r[k]))));
  return out.length ? { status: 200, body: out } : { status: 404, body: { detail: "No results found." } };
}

const newClient = (h: Handler = api) => {
  const f = fakeFetch(h);
  return { client: new OpenF1Client({ fetchImpl: f.impl, minIntervalMs: 0, maxRetries: 2 }), calls: f.calls };
};

// ---------- tests ----------

describe("buildQuery", () => {
  it("keeps comparison operators literal and repeats list params", () => {
    expect(
      buildQuery({ session_key: 9159, driver_number: [4, 81], skip: undefined }, [
        { field: "speed", op: ">=", value: 315 },
        { field: "date", op: "<", value: "2023-09-16T13:03:35.800" },
      ]),
    ).toBe("session_key=9159&driver_number=4&driver_number=81&speed>=315&date<2023-09-16T13%3A03%3A35.800");
  });

  it("encodes spaces in values", () => {
    expect(buildQuery({ flag: "BLACK AND WHITE" })).toBe("flag=BLACK%20AND%20WHITE");
  });
});

describe("OpenF1Client", () => {
  it("turns 404 'No results found' into an empty list", async () => {
    const { client } = newClient(() => ({ status: 404, body: { detail: "No results found." } }));
    expect(await client.get("laps", { session_key: 1 })).toEqual([]);
  });

  it("retries on 429 and then succeeds", async () => {
    let n = 0;
    const { client, calls } = newClient(() => (++n === 1 ? { status: 429, body: {}, headers: { "retry-after": "0.01" } } : { status: 200, body: [{ a: 1 }] }));
    expect(await client.get("laps")).toEqual([{ a: 1 }]);
    expect(calls).toHaveLength(2);
  });

  it("caches identical queries", async () => {
    const { client, calls } = newClient();
    await client.get("drivers", { session_key: 9999 });
    await client.get("drivers", { session_key: 9999 });
    expect(calls).toHaveLength(1);
  });

  it("gives a subscription hint on 401", async () => {
    const { client } = newClient(() => ({ status: 401, body: { detail: "Unauthorized" } }));
    await expect(client.get("laps", { session_key: "latest" })).rejects.toThrow(/paid OpenF1 subscription/);
  });
});

describe("shape", () => {
  const rows = Array.from({ length: 1000 }, (_, i) => ({ date: `t${i}`, speed: i, driver_number: 4 }));

  it("returns everything under the limit", () => {
    const r = shape(rows.slice(0, 5), { limit: 10 });
    expect(r.truncated).toBe(false);
    expect(r.records).toHaveLength(5);
  });

  it("samples evenly and summarizes all records", () => {
    const r = shape(rows, { limit: 100, sample: true, fields: ["speed"] });
    expect(r.truncated).toBe(true);
    expect(r.records).toHaveLength(100);
    expect(r.records[1]).toEqual({ speed: 10 });
    expect(r.summary?.numeric_fields.speed).toEqual({ min: 0, max: 999, avg: 499.5 });
    expect(r.summary?.numeric_fields.driver_number).toBeUndefined();
    expect(r.summary?.date_last).toBe("t999");
  });
});

describe("runEndpointQuery", () => {
  it("rejects unknown filter fields", async () => {
    const { client } = newClient();
    await expect(
      runEndpointQuery(client, findEndpoint("laps"), { session_key: 1, filters: [{ field: "nope", op: ">", value: 1 }] }),
    ).rejects.toThrow(/does not exist on laps/);
  });

  it("requires one driver for car_data", async () => {
    const { client } = newClient();
    await expect(runEndpointQuery(client, findEndpoint("car_data"), { session_key: 1, driver_number: [1, 4] })).rejects.toThrow(/exactly ONE/);
  });

  it("limits the car_data time range", async () => {
    const { client } = newClient();
    await expect(
      runEndpointQuery(client, findEndpoint("car_data"), {
        session_key: 1,
        driver_number: 4,
        date_from: "2025-11-09T17:00:00Z",
        date_to: "2025-11-09T17:30:00Z",
      }),
    ).rejects.toThrow(/maximum for get_car_data is 10 minutes/);
  });

  it("resolves lap_number to the lap time window for telemetry", async () => {
    const { client, calls } = newClient();
    const out = (await runEndpointQuery(client, findEndpoint("car_data"), { session_key: 9999, driver_number: 4, lap_number: 10 })) as {
      time_range: { from: string; to: string };
    };
    expect(out.time_range).toEqual({ from: "2025-11-09T17:15:00.000Z", to: "2025-11-09T17:16:12.500Z" });
    const carCall = calls.find((c) => c.includes("/car_data?"))!;
    expect(carCall).toContain("date>=2025-11-09T17%3A15%3A00.000Z");
    expect(carCall).toContain("date<=2025-11-09T17%3A16%3A12.500Z");
  });

  it("adds a hint when nothing is found", async () => {
    const { client } = newClient();
    const out = (await runEndpointQuery(client, findEndpoint("weather"), { session_key: 1 })) as { note: string };
    expect(out.note).toMatch(/No records found/);
  });
});

describe("composite tools", () => {
  it("builds a race summary with grid and status", async () => {
    const { client } = newClient();
    const s = await raceSummary(client, 9999);
    expect(s.standings!.map((r) => r.acronym)).toEqual(["NOR", "PIA", "VER"]);
    expect(s.standings![1]).toMatchObject({ grid: 4, positions_gained: 2, status: "Finished" });
    expect(s.standings![2]).toMatchObject({ status: "DNF", position: null });
  });

  it("builds a tyre strategy", async () => {
    const { client } = newClient();
    const t = await tyreStrategy(client, 9999, [4]);
    expect(t.drivers[0]).toMatchObject({ acronym: "NOR", compounds: "MEDIUM → HARD" });
    expect(t.drivers[0]!.stints[0]).toMatchObject({ laps: "1-24", length: 24 });
    expect(t.drivers[0]!.pit_stops).toEqual([{ lap: 24, lane_s: 21.9, stop_s: 2.3 }]);
  });

  it("compares fastest laps and ignores pit-out laps", async () => {
    const { client } = newClient();
    const c = await compareFastestLaps(client, 9999, [81, 4]);
    expect(c.comparison.map((r) => r.acronym)).toEqual(["NOR", "PIA"]);
    expect(c.comparison[0]!.fastest_lap).toMatchObject({ lap_number: 11, lap_s: 72.2 });
    expect(c.comparison[0]!.theoretical_best_s).toBe(72.1);
    expect(c.comparison[1]!.delta_to_best_s).toBe(0.4);
  });
});

describe("MCP server", () => {
  async function connect() {
    const { client: api1 } = newClient();
    const server = new McpServer({ name: "openf1", version: "test" });
    registerTools(server, api1);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const mcp = new Client({ name: "test", version: "1" });
    await Promise.all([server.connect(a), mcp.connect(b)]);
    return mcp;
  }

  it("lists 20 read-only tools and no team radio", async () => {
    const mcp = await connect();
    const { tools } = await mcp.listTools();
    expect(tools).toHaveLength(20);
    expect(tools.some((t) => t.name.includes("radio"))).toBe(false);
    expect(tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
  });

  it("calls a tool end to end", async () => {
    const mcp = await connect();
    const res = await mcp.callTool({ name: "get_drivers", arguments: { session_key: 9999, driver_number: [4, 81] } });
    const body = JSON.parse((res.content as { text: string }[])[0]!.text);
    expect(body.records.map((d: { name_acronym: string }) => d.name_acronym)).toEqual(["NOR", "PIA"]);
  });

  it("returns isError for bad input instead of throwing", async () => {
    const mcp = await connect();
    const res = await mcp.callTool({ name: "get_location", arguments: { session_key: 9999, driver_number: 4 } });
    expect(res.isError).toBe(true);
  });

  it("validates input with the schema", async () => {
    const mcp = await connect();
    const res = await mcp.callTool({ name: "get_laps", arguments: { session_key: "yesterday" } });
    expect(res.isError).toBe(true);
  });
});
