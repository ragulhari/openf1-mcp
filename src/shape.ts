/**
 * Response shaping: field projection, record limit and a numeric summary,
 * so that large OpenF1 responses do not fill the model context.
 */

export type Row = Record<string, unknown>;

export interface NumericStats {
  min: number;
  max: number;
  avg: number;
}

export interface Shaped {
  total_records: number;
  returned_records: number;
  truncated: boolean;
  /** Present when the result is truncated: stats on ALL records, not only the returned ones. */
  summary?: {
    date_first?: string;
    date_last?: string;
    numeric_fields: Record<string, NumericStats>;
  };
  records: Row[];
  note?: string;
}

export function project(rows: Row[], fields?: string[]): Row[] {
  if (!fields || fields.length === 0) return rows;
  return rows.map((r) => {
    const out: Row = {};
    for (const f of fields) if (f in r) out[f] = r[f];
    return out;
  });
}

const ID_FIELDS = new Set(["meeting_key", "session_key", "driver_number", "circuit_key", "country_key"]);

export function numericStats(rows: Row[]): Record<string, NumericStats> {
  const acc: Record<string, { min: number; max: number; sum: number; n: number }> = {};
  for (const r of rows) {
    for (const [k, v] of Object.entries(r)) {
      if (typeof v !== "number" || !Number.isFinite(v) || ID_FIELDS.has(k)) continue;
      const a = (acc[k] ??= { min: v, max: v, sum: 0, n: 0 });
      if (v < a.min) a.min = v;
      if (v > a.max) a.max = v;
      a.sum += v;
      a.n++;
    }
  }
  const out: Record<string, NumericStats> = {};
  for (const [k, a] of Object.entries(acc)) {
    out[k] = { min: a.min, max: a.max, avg: Math.round((a.sum / a.n) * 1000) / 1000 };
  }
  return out;
}

/**
 * Keeps at most `limit` records. When `sample` is true and the data is a time series,
 * records are sampled evenly over the full range instead of cut at the start.
 */
export function shape(rows: Row[], opts: { limit: number; fields?: string[]; sample?: boolean }): Shaped {
  const total = rows.length;
  if (total <= opts.limit) {
    return { total_records: total, returned_records: total, truncated: false, records: project(rows, opts.fields) };
  }

  let kept: Row[];
  if (opts.sample) {
    const step = total / opts.limit;
    kept = Array.from({ length: opts.limit }, (_, i) => rows[Math.floor(i * step)]!);
  } else {
    kept = rows.slice(0, opts.limit);
  }

  const dates = rows.map((r) => r.date ?? r.date_start).filter((d): d is string => typeof d === "string");
  return {
    total_records: total,
    returned_records: kept.length,
    truncated: true,
    summary: {
      ...(dates.length ? { date_first: dates[0], date_last: dates[dates.length - 1] } : {}),
      numeric_fields: numericStats(rows),
    },
    records: project(kept, opts.fields),
    note: opts.sample
      ? `Result has ${total} records. ${kept.length} records are sampled evenly over the full range. The summary uses all records. Use narrower filters to get every record.`
      : `Result has ${total} records. Only the first ${kept.length} are returned. The summary uses all records. Use narrower filters, "fields" or a larger "limit".`,
  };
}
