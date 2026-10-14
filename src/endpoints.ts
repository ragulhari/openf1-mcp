/**
 * OpenF1 endpoint catalog.
 * Team radio is intentionally excluded (coverage decreased in 2026).
 */

export type ParamKind =
  | "key" // integer or "latest"
  | "int"
  | "intList" // one or more integers (repeated query param)
  | "number"
  | "string"
  | "bool";

export interface EndpointDef {
  /** Tool name exposed by the MCP server. */
  tool: string;
  /** API path under /v1. */
  path: string;
  title: string;
  description: string;
  /** Typed parameters (equality filters) exposed directly on the tool. */
  params: Record<string, { kind: ParamKind; description: string }>;
  /** All attributes of the response. Used to validate free filters and field projection. */
  attributes: string[];
  /** True when the endpoint has a `date` attribute (enables date_from / date_to). */
  hasDate: boolean;
  /** High-volume telemetry endpoints need extra guards. */
  highVolume?: boolean;
}

const sessionKey = {
  kind: "key" as const,
  description: 'Session identifier. Use "latest" for the current or most recent session.',
};
const meetingKey = {
  kind: "key" as const,
  description: 'Meeting (Grand Prix weekend) identifier. Use "latest" for the current or most recent meeting.',
};
const driverNumber = {
  kind: "intList" as const,
  description: "Driver number(s) for the season, e.g. 1, 44, 81. Give a list to get more than one driver.",
};
const lapNumber = { kind: "int" as const, description: "Lap number (starts at 1)." };

export const ENDPOINTS: EndpointDef[] = [
  {
    tool: "get_meetings",
    path: "meetings",
    title: "Meetings (Grand Prix weekends)",
    description:
      "Find meetings (Grand Prix or testing weekends). Use this first to get a meeting_key. Data starts in 2023.",
    params: {
      year: { kind: "int", description: "Season year, e.g. 2025." },
      country_name: { kind: "string", description: 'Country name in English, e.g. "Brazil", "Singapore".' },
      location: { kind: "string", description: 'City or location, e.g. "São Paulo", "Monza".' },
      circuit_short_name: { kind: "string", description: 'Circuit short name, e.g. "Interlagos".' },
      meeting_key: meetingKey,
    },
    attributes: [
      "circuit_key", "circuit_info_url", "circuit_image", "circuit_short_name", "circuit_type",
      "country_code", "country_flag", "country_key", "country_name", "date_end", "date_start",
      "gmt_offset", "is_cancelled", "location", "meeting_key", "meeting_name",
      "meeting_official_name", "year",
    ],
    hasDate: false,
  },
  {
    tool: "get_sessions",
    path: "sessions",
    title: "Sessions",
    description:
      "Find sessions (practice, qualifying, sprint, race). Use this to get a session_key, which most other tools need.",
    params: {
      year: { kind: "int", description: "Season year, e.g. 2025." },
      country_name: { kind: "string", description: 'Country name in English, e.g. "Brazil".' },
      location: { kind: "string", description: 'City or location, e.g. "São Paulo".' },
      session_name: {
        kind: "string",
        description: 'Session name: "Practice 1", "Practice 2", "Practice 3", "Qualifying", "Sprint Qualifying", "Sprint", "Race".',
      },
      session_type: { kind: "string", description: 'Session type: "Practice", "Qualifying", "Race".' },
      meeting_key: meetingKey,
      session_key: sessionKey,
    },
    attributes: [
      "circuit_key", "circuit_short_name", "country_code", "country_key", "country_name",
      "date_end", "date_start", "gmt_offset", "is_cancelled", "location", "meeting_key",
      "session_key", "session_name", "session_type", "year",
    ],
    hasDate: false,
  },
  {
    tool: "get_drivers",
    path: "drivers",
    title: "Drivers",
    description: "Driver details for a session: name, acronym, team, team colour, headshot URL.",
    params: {
      session_key: sessionKey,
      meeting_key: meetingKey,
      driver_number: driverNumber,
      name_acronym: { kind: "string", description: 'Three-letter acronym, e.g. "VER", "HAM".' },
      team_name: { kind: "string", description: 'Team name, e.g. "McLaren".' },
    },
    attributes: [
      "broadcast_name", "country_code", "driver_number", "first_name", "full_name", "headshot_url",
      "last_name", "meeting_key", "name_acronym", "session_key", "team_colour", "team_name",
    ],
    hasDate: false,
  },
  {
    tool: "get_session_result",
    path: "session_result",
    title: "Session result",
    description:
      "Final standings of a session (position, laps, duration, gap, DNF/DNS/DSQ). In qualifying, duration and gap_to_leader are arrays for Q1, Q2, Q3.",
    params: {
      session_key: sessionKey,
      meeting_key: meetingKey,
      driver_number: driverNumber,
      position: { kind: "int", description: "Final position." },
    },
    attributes: [
      "dnf", "dns", "dsq", "driver_number", "duration", "gap_to_leader", "number_of_laps",
      "meeting_key", "position", "session_key",
    ],
    hasDate: false,
  },
  {
    tool: "get_starting_grid",
    path: "starting_grid",
    title: "Starting grid",
    description: "Starting grid of a race, with the qualifying lap time of each driver.",
    params: {
      session_key: sessionKey,
      meeting_key: meetingKey,
      driver_number: driverNumber,
      position: { kind: "int", description: "Grid position." },
    },
    attributes: ["driver_number", "lap_duration", "meeting_key", "position", "session_key"],
    hasDate: false,
  },
  {
    tool: "get_laps",
    path: "laps",
    title: "Laps",
    description:
      "Lap data: lap time, sector times, intermediate and speed-trap speeds, pit-out flag, mini-sector segments (segments are not available in races).",
    params: {
      session_key: sessionKey,
      meeting_key: meetingKey,
      driver_number: driverNumber,
      lap_number: lapNumber,
      is_pit_out_lap: { kind: "bool", description: "Only pit-out laps (true) or only other laps (false)." },
    },
    attributes: [
      "date_start", "driver_number", "duration_sector_1", "duration_sector_2", "duration_sector_3",
      "i1_speed", "i2_speed", "is_pit_out_lap", "lap_duration", "lap_number", "meeting_key",
      "segments_sector_1", "segments_sector_2", "segments_sector_3", "session_key", "st_speed",
    ],
    hasDate: false,
  },
  {
    tool: "get_stints",
    path: "stints",
    title: "Stints",
    description: "Tyre stints: compound, first and last lap, tyre age at the start of the stint.",
    params: {
      session_key: sessionKey,
      meeting_key: meetingKey,
      driver_number: driverNumber,
      compound: { kind: "string", description: '"SOFT", "MEDIUM", "HARD", "INTERMEDIATE", "WET".' },
      stint_number: { kind: "int", description: "Stint number (starts at 1)." },
    },
    attributes: [
      "compound", "driver_number", "lap_end", "lap_start", "meeting_key", "session_key",
      "stint_number", "tyre_age_at_start",
    ],
    hasDate: false,
  },
  {
    tool: "get_pit",
    path: "pit",
    title: "Pit lane",
    description:
      "Pit lane passages: lap, time in pit lane (lane_duration) and stationary stop time (stop_duration, from the 2024 US GP onwards).",
    params: {
      session_key: sessionKey,
      meeting_key: meetingKey,
      driver_number: driverNumber,
      lap_number: lapNumber,
    },
    attributes: [
      "date", "driver_number", "lane_duration", "lap_number", "meeting_key", "pit_duration",
      "session_key", "stop_duration",
    ],
    hasDate: true,
  },
  {
    tool: "get_position",
    path: "position",
    title: "Position changes",
    description: "Driver position during a session: the initial position and each change.",
    params: {
      session_key: sessionKey,
      meeting_key: meetingKey,
      driver_number: driverNumber,
      position: { kind: "int", description: "Position." },
    },
    attributes: ["date", "driver_number", "meeting_key", "position", "session_key"],
    hasDate: true,
  },
  {
    tool: "get_intervals",
    path: "intervals",
    title: "Intervals",
    description:
      "Gap to the car ahead and gap to the leader during a race (about every 4 s). Large data: filter by driver and time.",
    params: {
      session_key: sessionKey,
      meeting_key: meetingKey,
      driver_number: driverNumber,
    },
    attributes: ["date", "driver_number", "gap_to_leader", "interval", "meeting_key", "session_key"],
    hasDate: true,
  },
  {
    tool: "get_overtakes",
    path: "overtakes",
    title: "Overtakes",
    description:
      "Position exchanges between two drivers in a race (on track, pit stops or penalties). Data can be incomplete.",
    params: {
      session_key: sessionKey,
      meeting_key: meetingKey,
      overtaking_driver_number: { kind: "int", description: "Driver who made the overtake." },
      overtaken_driver_number: { kind: "int", description: "Driver who was overtaken." },
      position: { kind: "int", description: "Position of the overtaking driver after the overtake." },
    },
    attributes: [
      "date", "meeting_key", "overtaken_driver_number", "overtaking_driver_number", "position",
      "session_key",
    ],
    hasDate: true,
  },
  {
    tool: "get_race_control",
    path: "race_control",
    title: "Race control",
    description:
      "Race control messages: flags, safety car, DRS, penalties, track limits, session status.",
    params: {
      session_key: sessionKey,
      meeting_key: meetingKey,
      driver_number: driverNumber,
      category: { kind: "string", description: '"Flag", "SafetyCar", "Drs", "CarEvent", "SessionStatus", "Other".' },
      flag: { kind: "string", description: '"GREEN", "YELLOW", "DOUBLE YELLOW", "RED", "BLUE", "CHEQUERED", "BLACK AND WHITE", "CLEAR".' },
      scope: { kind: "string", description: '"Track", "Driver", "Sector".' },
      lap_number: lapNumber,
    },
    attributes: [
      "category", "date", "driver_number", "flag", "lap_number", "meeting_key", "message",
      "qualifying_phase", "scope", "sector", "session_key",
    ],
    hasDate: true,
  },
  {
    tool: "get_weather",
    path: "weather",
    title: "Weather",
    description: "Track weather each minute: air and track temperature, humidity, pressure, rain, wind.",
    params: {
      session_key: sessionKey,
      meeting_key: meetingKey,
      rainfall: { kind: "bool", description: "Only records with (true) or without (false) rain." },
    },
    attributes: [
      "air_temperature", "date", "humidity", "meeting_key", "pressure", "rainfall", "session_key",
      "track_temperature", "wind_direction", "wind_speed",
    ],
    hasDate: true,
  },
  {
    tool: "get_championship_drivers",
    path: "championship_drivers",
    title: "Drivers championship (beta)",
    description: "Drivers championship points and position before and after a race. Race sessions only.",
    params: {
      session_key: sessionKey,
      meeting_key: meetingKey,
      driver_number: driverNumber,
    },
    attributes: [
      "driver_number", "meeting_key", "points_current", "points_start", "position_current",
      "position_start", "session_key",
    ],
    hasDate: false,
  },
  {
    tool: "get_championship_teams",
    path: "championship_teams",
    title: "Teams championship (beta)",
    description: "Teams championship points and position before and after a race. Race sessions only.",
    params: {
      session_key: sessionKey,
      meeting_key: meetingKey,
      team_name: { kind: "string", description: 'Team name, e.g. "McLaren".' },
    },
    attributes: [
      "meeting_key", "points_current", "points_start", "position_current", "position_start",
      "session_key", "team_name",
    ],
    hasDate: false,
  },
  {
    tool: "get_car_data",
    path: "car_data",
    title: "Car telemetry",
    description:
      "Car telemetry at about 3.7 Hz: speed, RPM, gear, throttle, brake, DRS. VERY large data: you must give session_key, ONE driver_number and a lap_number or a date range (max 10 minutes).",
    params: {
      session_key: sessionKey,
      driver_number: driverNumber,
    },
    attributes: [
      "brake", "date", "driver_number", "drs", "meeting_key", "n_gear", "rpm", "session_key",
      "speed", "throttle",
    ],
    hasDate: true,
    highVolume: true,
  },
  {
    tool: "get_location",
    path: "location",
    title: "Car location",
    description:
      "Approximate car position on track (x, y, z) at about 3.7 Hz. VERY large data: you must give session_key, ONE driver_number and a lap_number or a date range (max 10 minutes).",
    params: {
      session_key: sessionKey,
      driver_number: driverNumber,
    },
    attributes: ["date", "driver_number", "meeting_key", "session_key", "x", "y", "z"],
    hasDate: true,
    highVolume: true,
  },
];

export function findEndpoint(path: string): EndpointDef {
  const e = ENDPOINTS.find((d) => d.path === path);
  if (!e) throw new Error(`Unknown endpoint: ${path}`);
  return e;
}
