# openf1-mcp

MCP server for the [OpenF1 API](https://openf1.org/docs/) — Formula 1 timing, telemetry and session data from 2023 onwards.

TypeScript, stdio transport, read-only. Team radio is not included (F1 decreased radio coverage in 2026).

## Tools

**Discovery**

| Tool | Use |
| --- | --- |
| `get_meetings` | Find Grand Prix weekends → `meeting_key` |
| `get_sessions` | Find practice / qualifying / sprint / race → `session_key` |
| `get_drivers` | Map driver numbers to names and teams |

**Data (one tool for each endpoint)**

`get_session_result`, `get_starting_grid`, `get_laps`, `get_stints`, `get_pit`, `get_position`, `get_intervals`, `get_overtakes`, `get_race_control`, `get_weather`, `get_championship_drivers`, `get_championship_teams`, `get_car_data`, `get_location`.

**Composite**

| Tool | Result |
| --- | --- |
| `get_race_summary` | Classification with names, teams, grid, positions gained, status (DNF/DNS/DSQ) |
| `get_tyre_strategy` | Compound sequence, stint lengths and pit stops for each driver |
| `compare_fastest_laps` | Fastest lap, sectors, speeds, theoretical best lap and delta for 2–10 drivers |

All tools accept `"latest"` for `session_key` / `meeting_key`.

### Common arguments

- **Typed parameters** – equality filters such as `session_key`, `driver_number` (one number or a list), `lap_number`.
- **`filters`** – comparison filters: `[{"field":"lap_duration","op":"<","value":90}]`. The server checks the field names.
- **`date_from` / `date_to`** – time range (UTC, ISO 8601) for endpoints with a `date` attribute.
- **`fields`** – return only these attributes.
- **`limit`** – maximum records (default 200, max 1000).

### Size control

Large results do not go to the model in full:

- Results above `limit` are **sampled evenly** for time series (or cut for other data) and get a **summary** (min / max / avg of numeric fields and first / last date) computed on **all** records.
- `get_car_data` and `get_location` (~3.7 Hz) need `session_key`, **one** `driver_number`, and a `lap_number` **or** a date range of 10 minutes or less. With `lap_number`, the server finds the start and end of the lap for you.

### Reliability

- Cache: 6 h for historical data, 10 min for the calendar, 10 s for `latest` queries.
- Requests are spaced (350 ms) and retried on HTTP 429 / 5xx.
- "No results found" (HTTP 404) is returned as an empty list with a hint.
- Errors go back to the model as `isError` results with a clear message.

## Install

Node.js 20 or later.

```bash
npm install
npm run build
npm test          # unit + MCP protocol tests (no network)
npm run smoke     # tests against the real OpenF1 API
```

### Claude Code

```bash
claude mcp add openf1 -- node /absolute/path/openf1-mcp/dist/index.js
```

### Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "openf1": {
      "command": "node",
      "args": ["/absolute/path/openf1-mcp/dist/index.js"]
    }
  }
}
```

### MCP Inspector

```bash
npm run inspect
```

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `OPENF1_TOKEN` | – | Bearer token for the paid real-time tier. Historical data needs no token. |
| `OPENF1_BASE_URL` | `https://api.openf1.org/v1` | API base URL. |
| `OPENF1_MIN_INTERVAL_MS` | `350` | Minimum time between requests. |
| `OPENF1_DEFAULT_LIMIT` | `200` | Default record limit. |

## Example prompts

- "Who won the 2025 São Paulo GP and how many positions did each driver gain?"
- "Compare the tyre strategies of Norris and Piastri in the last race."
- "Show the speed and throttle of Verstappen on lap 10 of the latest race."
- "Were there safety cars in the 2025 Brazil race? On which laps?"

## Project structure

```
src/
  index.ts      stdio entry point, server instructions, env config
  endpoints.ts  endpoint catalog (parameters, attributes, guards)
  client.ts     HTTP client: query builder, cache, throttle, retry
  shape.ts      projection, limit, sampling, numeric summary
  tools.ts      tool registration, telemetry guards, composite tools
test/           vitest suite with a fake API
scripts/smoke.ts  real API check
```

## Notes

OpenF1 is an unofficial project and is not associated with the Formula 1 companies. F1 and related marks are trademarks of Formula One Licensing B.V.
