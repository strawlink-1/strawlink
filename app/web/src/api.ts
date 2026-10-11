export const API = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") ?? "http://localhost:8000";
export const MAPS_KEY = import.meta.env.VITE_MAPS_KEY as string | undefined;
export const MAPS_REGION = (import.meta.env.VITE_MAPS_REGION as string | undefined) ?? "ap-south-1";

export async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${API}${path}`);
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

export async function post<T>(path: string, body: unknown, raw = false): Promise<T> {
  const r = await fetch(`${API}${path}`, {
    method: "POST",
    headers: { "Content-Type": raw ? "text/csv" : "application/json" },
    body: raw ? (body as string) : JSON.stringify(body ?? {}),
  });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

export type Window = { p10: string; p50: string; p90: string; source: string; confidence?: number; issued_on?: string; confirmed_by?: string };
export type Slot = { date: string; machine_id: string; type: string; arrive: string; depart: string; method: "bale" | "seed"; operator?: string };
export type FieldProps = {
  field_id: string; village_id: string; village_name: string; area_ha: number; straw_t: number;
  status: Status; route?: "bale" | "seed" | "at_risk"; priority?: number; harvest_window?: Window | null;
  slot?: Slot | null; cleared_on?: string | null; synthetic?: boolean;
};
export type Status = "forecast" | "ready" | "scheduled" | "cleared" | "at_risk" | "wet";
export type FC = { type: "FeatureCollection"; date: string; features: { type: "Feature"; geometry: GeoJSON.Geometry; properties: FieldProps }[] };

export type Meta = {
  plan_date: string; today: string; live_dates: string[];
  villages: { properties: { village_id: string; name: string; name_pa?: string }; geometry: { coordinates: [number, number] } }[];
  plants: { plant_id: string; name: string; location: [number, number]; weekly_capacity_t: number; depot_capacity_t: number; fill_t: number }[];
  assumptions: { key: string; value: string; note: string; source: string }[];
  params: Record<string, string | number>;
  fields_note?: string; demo_fields: string[]; bedrock_model?: string | null;
  /** real past days whose rain the simulator can replay */
  weather_replay_days?: string[];
  forecast_report?: { validation?: { p50_mae_days: number; coverage_p10_p90: number; mean_width_days: number; n: number } } | null;
};

export const STATUS: Record<Status, { label: string; color: string; hint: string }> = {
  forecast: { label: "Not harvested yet", color: "var(--forecast)", hint: "The paddy is still standing; harvest is expected later (satellite forecast)." },
  ready: { label: "Waiting for a machine", color: "var(--ready)", hint: "Harvested or due, but no machine is free for it today." },
  scheduled: { label: "Scheduled today", color: "var(--sched)", hint: "A machine visits this field today. It turns green once the machine has finished." },
  cleared: { label: "Cleared", color: "var(--cleared)", hint: "Straw cleared; certificate issued." },
  at_risk: { label: "At risk", color: "var(--risk)", hint: "Neither route can reach it before the sowing deadline." },
  wet: { label: "Too wet", color: "var(--wet)", hint: "Recent rain above the wet threshold; machines wait." },
};

export const fmtDate = (d?: string | null) =>
  d ? new Date(d + (d.length === 10 ? "T00:00:00" : "")).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "—";
export const fmtTime = (iso?: string) => (iso ? iso.slice(11, 16) : "—");
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

/** BA01 → "Baler 1", SE02 → "Seeder 2", TR03 → "Truck 3" (ids come from config/synthetic.yaml). */
export const machineName = (id: string) => {
  const kind = { BA: "Baler", SE: "Seeder", TR: "Truck" }[id.slice(0, 2)];
  const n = parseInt(id.slice(2), 10);
  return kind && !isNaN(n) ? `${kind} ${n}` : id;
};
