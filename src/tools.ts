import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { OpenF1Client, OpenF1Error, type Filter, type Scalar } from "./client.js";
import { ENDPOINTS, type EndpointDef, type ParamKind } from "./endpoints.js";
import { shape, type Row } from "./shape.js";

export interface ToolConfig {
  /** Default record limit for normal endpoints. */
  defaultLimit: number;
  /** Hard maximum for the "limit" argument. */
  maxLimit: number;
  /** Maximum date window for high-volume telemetry, in minutes. */
  maxTelemetryWindowMin: number;
}

export const DEFAULT_CONFIG: ToolConfig = { defaultLimit: 200, maxLimit: 1000, maxTelemetryWindowMin: 10 };

class UserInputError extends Error {}

// ---------- schemas ----------

const keySchema = z.union([z.number().int().positive(), z.literal("latest")]);
const intListSchema = z.union([z.number().int(), z.array(z.number().int()).min(1).max(30)]);

function schemaFor(kind: ParamKind, description: string) {
  const base = {
    key: keySchema,
    int: z.number().int(),
    intList: intListSchema,
    number: z.number(),
    string: z.string().min(1),
    bool: z.boolean(),
  }[kind];
  return base.optional().describe(description);
}

const filterSchema = z.object({
  field: z.string().describe("Attribute name of the endpoint."),
  op: z.enum(["=", ">", ">=", "<", "<="]),
  value: z.union([z.string(), z.number(), z.boolean()]),
});

function inputShapeFor(def: EndpointDef) {
  const shapeObj: Record<string, z.ZodTypeAny> = {};
  for (const [name, p] of Object.entries(def.params)) shapeObj[name] = schemaFor(p.kind, p.description);

  if (def.highVolume) {
    shapeObj.lap_number = z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Lap number. The server finds the start and end time of this lap and returns only its telemetry.");
  }
  if (def.hasDate) {
    shapeObj.date_from = z
      .string()
      .optional()
      .describe('Start of the time range (UTC, ISO 8601), e.g. "2025-11-09T17:05:00Z". Filters on "date" >= value.');
    shapeObj.date_to = z
      .string()
      .optional()
      .describe('End of the time range (UTC, ISO 8601). Filters on "date" <= value.');
  }
  shapeObj.filters = z
    .array(filterSchema)
    .max(20)
    .optional()
    .describe(
      `Extra comparison filters, e.g. [{"field":"lap_duration","op":"<","value":90}]. Allowed fields: ${def.attributes.join(", ")}. Array fields cannot be filtered.`,
    );
  shapeObj.fields = z
    .array(z.string())
    .optional()
    .describe("Return only these attributes. Use this to make large results smaller.");
  shapeObj.limit = z
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum number of records to return (default 200, max 1000). A summary is added when the result is larger.");
  return shapeObj;
}

// ---------- endpoint query ----------

type Args = Record<string, unknown>;

function parseDate(value: string, label: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new UserInputError(`${label} "${value}" is not a valid date. Use ISO 8601, e.g. 2025-11-09T17:05:00Z.`);
  }
  return d;
}

function asList(v: unknown): number[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? (v as number[]) : [v as number];
}

/** Finds the time window of one lap, for telemetry endpoints. */
export async function lapWindow(
  client: OpenF1Client,
  sessionKey: number | "latest",
  driverNumber: number,
  lapNumber: number,
): Promise<{ from: string; to: string }> {
  const laps = await client.get<Row>("laps", {
    session_key: sessionKey,
    driver_number: driverNumber,
    lap_number: [lapNumber, lapNumber + 1],
  });
  const lap = laps.find((l) => l.lap_number === lapNumber);
  if (!lap || typeof lap.date_start !== "string") {
    throw new UserInputError(
      `Lap ${lapNumber} of driver ${driverNumber} has no start time in session ${sessionKey}. Use get_laps to see the available laps.`,
    );
  }
  const start = new Date(lap.date_start);
  const next = laps.find((l) => l.lap_number === lapNumber + 1);
  let end: Date;
  if (typeof next?.date_start === "string") end = new Date(next.date_start);
  else if (typeof lap.lap_duration === "number") end = new Date(start.getTime() + lap.lap_duration * 1000);
  else end = new Date(start.getTime() + 180_000); // lap time unknown (e.g. in/out lap): use 3 minutes
  return { from: start.toISOString(), to: end.toISOString() };
}

export async function runEndpointQuery(
  client: OpenF1Client,
  def: EndpointDef,
  args: Args,
  config: ToolConfig = DEFAULT_CONFIG,
): Promise<unknown> {
  const params: Record<string, Scalar | Scalar[]> = {};
  for (const name of Object.keys(def.params)) {
    const v = args[name];
    if (v !== undefined) params[name] = v as Scalar | Scalar[];
  }

  const filters: Filter[] = [];
  for (const f of (args.filters as Filter[] | undefined) ?? []) {
    if (!def.attributes.includes(f.field)) {
      throw new UserInputError(`Filter field "${f.field}" does not exist on ${def.path}. Allowed: ${def.attributes.join(", ")}.`);
    }
    filters.push(f);
  }

  const fields = args.fields as string[] | undefined;
  const unknownFields = (fields ?? []).filter((f) => !def.attributes.includes(f));
  if (unknownFields.length) {
    throw new UserInputError(`Unknown fields for ${def.path}: ${unknownFields.join(", ")}. Allowed: ${def.attributes.join(", ")}.`);
  }

  let dateFrom = args.date_from as string | undefined;
  let dateTo = args.date_to as string | undefined;

  if (def.highVolume) {
    const drivers = asList(args.driver_number);
    const sessionKey = args.session_key as number | "latest" | undefined;
    if (sessionKey === undefined || drivers.length !== 1) {
      throw new UserInputError(
        `${def.tool} needs session_key and exactly ONE driver_number, because this data is very large (about 3.7 records per second).`,
      );
    }
    const lapNumber = args.lap_number as number | undefined;
    if (lapNumber !== undefined) {
      if (dateFrom || dateTo) throw new UserInputError("Give lap_number OR date_from/date_to, not both.");
      ({ from: dateFrom, to: dateTo } = await lapWindow(client, sessionKey, drivers[0]!, lapNumber));
    } else {
      if (!dateFrom || !dateTo) {
        throw new UserInputError(
          `${def.tool} needs lap_number, or date_from and date_to (max ${config.maxTelemetryWindowMin} minutes). Use get_laps to find lap start times.`,
        );
      }
      const from = parseDate(dateFrom, "date_from");
      const to = parseDate(dateTo, "date_to");
      const minutes = (to.getTime() - from.getTime()) / 60_000;
      if (minutes <= 0) throw new UserInputError("date_to must be after date_from.");
      if (minutes > config.maxTelemetryWindowMin) {
        throw new UserInputError(
          `Time range is ${minutes.toFixed(1)} minutes. The maximum for ${def.tool} is ${config.maxTelemetryWindowMin} minutes.`,
        );
      }
    }
  }

  if (dateFrom) filters.push({ field: "date", op: ">=", value: dateFrom });
  if (dateTo) filters.push({ field: "date", op: "<=", value: dateTo });

  const limit = Math.min((args.limit as number | undefined) ?? config.defaultLimit, config.maxLimit);
  const rows = await client.get<Row>(def.path, params, filters);
  const result = shape(rows, { limit, fields, sample: def.hasDate });
  const withRange = def.highVolume ? { time_range: { from: dateFrom, to: dateTo }, ...result } : result;
  if (rows.length === 0) {
    return {
      ...withRange,
      note: "No records found. Check the keys (use get_sessions / get_meetings), the filters, and that the data is from 2023 or later.",
    };
  }
  return withRange;
}

// ---------- composite tools ----------

function byDriver(drivers: Row[]): Map<number, Row> {
  const m = new Map<number, Row>();
  for (const d of drivers) if (typeof d.driver_number === "number") m.set(d.driver_number, d);
  return m;
}

function driverLabel(d: Row | undefined, n: number) {
  return d
    ? { driver_number: n, acronym: d.name_acronym, name: d.full_name, team: d.team_name }
    : { driver_number: n };
}

export async function raceSummary(client: OpenF1Client, sessionKey: number | "latest") {
  const [sessions, results, drivers, grid] = await Promise.all([
    client.get<Row>("sessions", { session_key: sessionKey }),
    client.get<Row>("session_result", { session_key: sessionKey }),
    client.get<Row>("drivers", { session_key: sessionKey }),
    client.get<Row>("starting_grid", { session_key: sessionKey }).catch(() => [] as Row[]),
  ]);
  if (results.length === 0) {
    return { session: sessions[0] ?? null, note: "No result yet for this session. Results appear a few minutes after the official publication." };
  }
  const dmap = byDriver(drivers);
  const gmap = new Map(grid.map((g) => [g.driver_number as number, g.position as number]));
  const standings = [...results]
    .sort((a, b) => ((a.position as number) ?? 99) - ((b.position as number) ?? 99))
    .map((r) => {
      const n = r.driver_number as number;
      const gridPos = gmap.get(n);
      const status = r.dsq ? "DSQ" : r.dns ? "DNS" : r.dnf ? "DNF" : "Finished";
      return {
        position: r.position ?? null,
        ...driverLabel(dmap.get(n), n),
        grid: gridPos ?? null,
        positions_gained: gridPos && typeof r.position === "number" ? gridPos - r.position : null,
        laps: r.number_of_laps,
        duration_s: r.duration,
        gap_to_leader: r.gap_to_leader,
        status,
      };
    });
  const s = sessions[0];
  return {
    session: s
      ? {
          session_key: s.session_key,
          name: s.session_name,
          location: s.location,
          country: s.country_name,
          circuit: s.circuit_short_name,
          date_start: s.date_start,
          year: s.year,
        }
      : null,
    standings,
  };
}

export async function tyreStrategy(client: OpenF1Client, sessionKey: number | "latest", driverNumbers: number[]) {
  const dn = driverNumbers.length ? driverNumbers : undefined;
  const [stints, pits, drivers] = await Promise.all([
    client.get<Row>("stints", { session_key: sessionKey, driver_number: dn }),
    client.get<Row>("pit", { session_key: sessionKey, driver_number: dn }),
    client.get<Row>("drivers", { session_key: sessionKey, driver_number: dn }),
  ]);
  const dmap = byDriver(drivers);
  const numbers = [...new Set(stints.map((s) => s.driver_number as number))].sort((a, b) => a - b);
  return {
    session_key: sessionKey,
    drivers: numbers.map((n) => {
      const st = stints
        .filter((s) => s.driver_number === n)
        .sort((a, b) => (a.stint_number as number) - (b.stint_number as number));
      const pt = pits
        .filter((p) => p.driver_number === n)
        .sort((a, b) => ((a.lap_number as number) ?? 0) - ((b.lap_number as number) ?? 0));
      return {
        ...driverLabel(dmap.get(n), n),
        compounds: st.map((s) => s.compound).join(" → "),
        stints: st.map((s) => ({
          stint: s.stint_number,
          compound: s.compound,
          laps: `${s.lap_start}-${s.lap_end}`,
          length: typeof s.lap_start === "number" && typeof s.lap_end === "number" ? s.lap_end - s.lap_start + 1 : null,
          tyre_age_at_start: s.tyre_age_at_start,
        })),
        pit_stops: pt.map((p) => ({ lap: p.lap_number, lane_s: p.lane_duration ?? p.pit_duration, stop_s: p.stop_duration ?? null })),
      };
    }),
  };
}

export async function compareFastestLaps(client: OpenF1Client, sessionKey: number | "latest", driverNumbers: number[]) {
  const [laps, drivers] = await Promise.all([
    client.get<Row>("laps", { session_key: sessionKey, driver_number: driverNumbers }),
    client.get<Row>("drivers", { session_key: sessionKey, driver_number: driverNumbers }),
  ]);
  const dmap = byDriver(drivers);
  const valid = (l: Row) => typeof l.lap_duration === "number" && !l.is_pit_out_lap;

  const rows = driverNumbers.map((n) => {
    const own = laps.filter((l) => l.driver_number === n && valid(l));
    const best = own.reduce<Row | undefined>((acc, l) => (!acc || (l.lap_duration as number) < (acc.lap_duration as number) ? l : acc), undefined);
    const minOf = (k: string) => {
      const vals = own.map((l) => l[k]).filter((v): v is number => typeof v === "number");
      return vals.length ? Math.min(...vals) : null;
    };
    const s1 = minOf("duration_sector_1"), s2 = minOf("duration_sector_2"), s3 = minOf("duration_sector_3");
    return {
      ...driverLabel(dmap.get(n), n),
      valid_laps: own.length,
      fastest_lap: best
        ? {
            lap_number: best.lap_number,
            lap_s: best.lap_duration,
            sector_1_s: best.duration_sector_1,
            sector_2_s: best.duration_sector_2,
            sector_3_s: best.duration_sector_3,
            i1_kmh: best.i1_speed,
            i2_kmh: best.i2_speed,
            speed_trap_kmh: best.st_speed,
          }
        : null,
      best_sectors_s: { s1, s2, s3 },
      theoretical_best_s: s1 !== null && s2 !== null && s3 !== null ? round3(s1 + s2 + s3) : null,
    };
  });

  const bestTime = Math.min(...rows.map((r) => (r.fastest_lap?.lap_s as number | undefined) ?? Infinity));
  return {
    session_key: sessionKey,
    comparison: rows
      .sort((a, b) => ((a.fastest_lap?.lap_s as number) ?? Infinity) - ((b.fastest_lap?.lap_s as number) ?? Infinity))
      .map((r) => ({
        ...r,
        delta_to_best_s: r.fastest_lap && Number.isFinite(bestTime) ? round3((r.fastest_lap.lap_s as number) - bestTime) : null,
      })),
  };
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

// ---------- registration ----------

function ok(data: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

function fail(err: unknown): CallToolResult {
  const msg =
    err instanceof UserInputError || err instanceof OpenF1Error
      ? err.message
      : `Unexpected error: ${(err as Error)?.message ?? String(err)}`;
  return { isError: true, content: [{ type: "text", text: msg }] };
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

export function registerTools(server: McpServer, client: OpenF1Client, config: ToolConfig = DEFAULT_CONFIG) {
  for (const def of ENDPOINTS) {
    server.registerTool(
      def.tool,
      {
        title: def.title,
        description: def.description,
        inputSchema: inputShapeFor(def),
        annotations: { title: def.title, ...READ_ONLY },
      },
      async (args: Args) => {
        try {
          return ok(await runEndpointQuery(client, def, args, config));
        } catch (err) {
          return fail(err);
        }
      },
    );
  }

  server.registerTool(
    "get_race_summary",
    {
      title: "Race summary",
      description:
        "Classification of a session with driver names, teams, grid position, positions gained, laps, gap and status (DNF/DNS/DSQ). Works for races, sprints, qualifying and practice.",
      inputSchema: { session_key: keySchema.describe('Session identifier or "latest".') },
      annotations: { title: "Race summary", ...READ_ONLY },
    },
    async ({ session_key }) => {
      try {
        return ok(await raceSummary(client, session_key));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "get_tyre_strategy",
    {
      title: "Tyre strategy",
      description: "Tyre strategy for each driver in a session: compound sequence, stint lengths and pit stops.",
      inputSchema: {
        session_key: keySchema.describe('Session identifier or "latest".'),
        driver_number: intListSchema.optional().describe("Optional driver number(s). Omit for all drivers."),
      },
      annotations: { title: "Tyre strategy", ...READ_ONLY },
    },
    async ({ session_key, driver_number }) => {
      try {
        return ok(await tyreStrategy(client, session_key, asList(driver_number)));
      } catch (err) {
        return fail(err);
      }
    },
  );

  server.registerTool(
    "compare_fastest_laps",
    {
      title: "Compare fastest laps",
      description:
        "Compare the fastest lap of 2 to 10 drivers in a session: lap time, sectors, speeds, best sectors, theoretical best lap and delta to the fastest driver.",
      inputSchema: {
        session_key: keySchema.describe('Session identifier or "latest".'),
        driver_number: z.array(z.number().int()).min(2).max(10).describe("Driver numbers to compare."),
      },
      annotations: { title: "Compare fastest laps", ...READ_ONLY },
    },
    async ({ session_key, driver_number }) => {
      try {
        return ok(await compareFastestLaps(client, session_key, driver_number));
      } catch (err) {
        return fail(err);
      }
    },
  );
}
