/** Shared types between server, client and the pure helpers. */

export type BinType = "residual" | "organic" | "paper" | "packaging" | "glass" | "bulky" | "hazardous" | "christmas" | "custom";

export const BIN_TYPES: BinType[] = ["residual", "organic", "paper", "packaging", "glass", "bulky", "hazardous", "christmas", "custom"];

export type SourceKind = "jumomind" | "ics" | "manual";

/** A rule for a manual bin: every N weeks on a weekday from a start date, or a fixed list of dates. */
export type ManualRule = { mode: "weekly"; interval: number; weekday: number; start: string } | { mode: "dates"; dates: string[] };

export type Source = {
  id: string;
  kind: SourceKind;
  name: string;
  /** JSON, shape depends on `kind` (see SourceConfig) */
  config: string;
  last_fetched: string | null;
  error: string | null;
  created_at: string;
};

export type JumomindConfig = { provider: "jumomind"; cityId: string; cityName: string; areaId: string; streetId?: string; streetName?: string };
export type IcsConfig = { url: string };
export type ManualConfig = { shiftOnHolidays?: boolean };
export type SourceConfig = JumomindConfig | IcsConfig | ManualConfig;

export type Bin = {
  id: string;
  source_id: string;
  type: BinType;
  name: string;
  color: string;
  icon: string;
  /** provider key (trash_name) or ics summary that maps to this bin; null for manual bins */
  key: string | null;
  enabled: number;
  /** JSON ManualRule for manual bins, else null */
  rule: string | null;
  created_at: string;
};

export type SourceView = Omit<Source, "config"> & { config: SourceConfig; binCount: number; pickupCount: number };

export type PickupView = {
  binId: string;
  bin: { name: string; type: BinType; color: string; icon: string };
  date: string;
  daysUntil: number;
  putOut: boolean;
};

export type Overview = {
  today: string;
  lookaheadDays: number;
  sources: SourceView[];
  bins: Bin[];
  upcoming: PickupView[];
};

export type GeoResult = { city: string; street: string; houseNumber: string; postcode: string; display: string } | null;
