import type { XZ } from "./geo";

/* ---- plan.json (contracts/plan.schema.json) ---- */
export type Stop = { field_id: string; arrive: string; depart: string; tonnes: number; method: string };
export type Delivery = { plant_id: string; tonnes: number; arrive: string };
export type MachineType = "baler_set" | "seeder" | "truck";
export type Assignment = { machine_id: string; type: MachineType; stops: Stop[]; deliveries: Delivery[] };
export type Plan = {
  plan_id: string; policy: string; date: string;
  fields?: { field_id: string; priority: number; priority_parts: { tonnes: number; urgency: number; bonus: number; dry: number }; route: string; route_reason: string; days_left: number; dry: boolean }[];
  assignments: Assignment[];
  unassigned: { field_id: string; reason: string }[];
  totals: { tonnes_planned: number; fields_planned: number; fields_at_risk: number };
  solver: { status: string; runtime_s: number };
};

/** Minutes since midnight (IST) straight from the plan's ISO string — no timezone maths. */
export const mins = (iso: string) => +iso.slice(11, 13) * 60 + +iso.slice(14, 16);
export const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(Math.floor(m % 60)).padStart(2, "0")}`;

type Key = { t: number; x: number; z: number };
export type Work = { field_id: string; machine: string; t0: number; t1: number; tonnes: number; method: string };
export type Track = {
  id: string; type: MachineType; keys: Key[]; work: Work[];
  /** trucks: [time, tonnes on board after this event] */
  load: [number, number][];
  /** the whole day's route, for drawing */
  path: XZ[];
};
export type DayPlan = {
  planId: string;
  tracks: Track[];
  /** field → the field machine's visit */
  service: Map<string, Work>;
  /** field → time a truck collects its bales (bale route only) */
  pickup: Map<string, number>;
  /** plant → [time, tonnes delivered] */
  drops: Map<string, [number, number][]>;
  /** truck trips today, for the supply view: field → plant */
  trips: { field_id: string; plant_id: string; tonnes: number }[];
  t0: number; t1: number;
};

const dist = (a: XZ, b: XZ) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const length = (line: XZ[]) => line.reduce((d, p, i) => (i ? d + dist(line[i - 1], p) : 0), 0);

/** Spread a polyline's vertices by distance over [t0, t1], easing out of and into the ends. */
function timed(line: XZ[], t0: number, t1: number): Key[] {
  const cum = [0];
  for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + dist(line[i - 1], line[i]));
  const total = cum[cum.length - 1] || 1;
  return line.map((p, i) => ({ t: t0 + (t1 - t0) * (cum[i] / total), x: p[0], z: p[1] }));
}

export type Layout = {
  fieldAt: Map<string, XZ>;
  baseAt: Map<string, XZ>;
  plantAt: Map<string, XZ>;
  /** the drawn path between two points (road route, or a straight line) */
  leg: (a: XZ, b: XZ, machine: string) => XZ[];
  unitsPerMin: number;
};

/**
 * Turn a plan into something that can be played: where every machine is at every minute.
 * Arrival and departure times are the plan's; this only adds the drive in between.
 */
export function buildDayPlan(plan: Plan, L: Layout): DayPlan {
  const tracks: Track[] = [];
  const service = new Map<string, Work>();
  const pickup = new Map<string, number>();
  const drops = new Map<string, [number, number][]>();
  const trips: DayPlan["trips"] = [];
  let lo = Infinity, hi = -Infinity;
  const drive = (len: number) => Math.max(3, len / L.unitsPerMin);

  for (const a of plan.assignments) {
    const keys: Key[] = [];
    const work: Work[] = [];
    const load: [number, number][] = [];
    const path: XZ[] = [];

    if (a.type !== "truck") {
      const stops = a.stops.filter((s) => L.fieldAt.has(s.field_id));
      if (!stops.length) continue;
      let here: XZ = L.baseAt.get(a.machine_id) ?? L.fieldAt.get(stops[0].field_id)!;
      let free: number | null = null; // when the machine left its previous field
      for (const s of stops) {
        const target = L.fieldAt.get(s.field_id)!;
        const leg = L.leg(here, target, a.machine_id);
        const arrive = mins(s.arrive), depart = mins(s.depart);
        const need = drive(length(leg));
        const start = free === null ? arrive - need : Math.min(free, arrive);
        const end = free === null ? arrive : Math.min(arrive, start + need);
        keys.push(...timed(leg, start, end));
        if (end < arrive) keys.push({ t: arrive, x: target[0], z: target[1] });
        keys.push({ t: depart, x: target[0], z: target[1] });
        path.push(...leg);
        const w: Work = { field_id: s.field_id, machine: a.machine_id, t0: arrive, t1: depart, tonnes: s.tonnes, method: s.method };
        work.push(w);
        service.set(s.field_id, w);
        here = target; free = depart;
      }
    } else {
      type Ev = { t: number; at: XZ; delta: number; plant?: string; field?: string };
      const evs: Ev[] = [];
      for (const s of a.stops) if (L.fieldAt.has(s.field_id)) evs.push({ t: mins(s.arrive), at: L.fieldAt.get(s.field_id)!, delta: s.tonnes, field: s.field_id });
      for (const d of a.deliveries) if (L.plantAt.has(d.plant_id)) evs.push({ t: mins(d.arrive), at: L.plantAt.get(d.plant_id)!, delta: -d.tonnes, plant: d.plant_id });
      evs.sort((p, q) => p.t - q.t);
      if (!evs.length) continue;
      let here: XZ = L.baseAt.get(a.machine_id) ?? evs[0].at;
      let prev: Ev | null = null;
      let haul = 30; // minutes the last loaded trip took; the empty trip back takes the same
      let onboard = 0;
      const carried: string[] = [];
      for (const e of evs) {
        const leg = L.leg(here, e.at, a.machine_id);
        const gap: number = prev ? e.t - prev.t : 0;
        // loaded trip to the plant: the plan's own travel time. Otherwise drive, then wait.
        const need: number = !prev ? drive(length(leg)) : e.plant ? gap : prev.plant ? Math.min(gap, haul) : Math.min(gap, drive(length(leg)));
        const start: number = prev ? prev.t : e.t - need;
        keys.push(...timed(leg, start, start + need));
        if (start + need < e.t) keys.push({ t: e.t, x: e.at[0], z: e.at[1] });
        path.push(...leg);
        if (e.plant) {
          haul = Math.max(5, gap);
          drops.set(e.plant, [...(drops.get(e.plant) ?? []), [e.t, -e.delta]]);
          for (const f of carried.splice(0)) trips.push({ field_id: f, plant_id: e.plant, tonnes: -e.delta });
        } else if (e.field) {
          pickup.set(e.field, e.t);
          carried.push(e.field);
        }
        onboard = Math.max(0, onboard + e.delta);
        load.push([e.t, onboard]);
        here = e.at; prev = e;
      }
    }
    lo = Math.min(lo, keys[0].t);
    hi = Math.max(hi, keys[keys.length - 1].t);
    tracks.push({ id: a.machine_id, type: a.type, keys, work, load, path });
  }
  if (!isFinite(lo)) { lo = 8 * 60; hi = 18 * 60; }
  return { planId: plan.plan_id, tracks, service, pickup, drops, trips, t0: Math.floor((lo - 10) / 30) * 30, t1: Math.ceil((hi + 10) / 30) * 30 };
}

/** Position on a track at time t (clamped to its ends). */
export function at(track: Track, t: number, out: { x: number; z: number }) {
  const k = track.keys;
  if (t <= k[0].t) { out.x = k[0].x; out.z = k[0].z; return; }
  const last = k[k.length - 1];
  if (t >= last.t) { out.x = last.x; out.z = last.z; return; }
  let lo = 0, hi = k.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (k[m].t <= t) lo = m; else hi = m; }
  const a = k[lo], b = k[hi], f = b.t > a.t ? (t - a.t) / (b.t - a.t) : 1;
  out.x = a.x + (b.x - a.x) * f; out.z = a.z + (b.z - a.z) * f;
}

export const working = (track: Track, t: number) => {
  for (const w of track.work) if (t >= w.t0 && t < w.t1) return w;
  return null;
};
export const loadAt = (track: Track, t: number) => {
  let v = 0;
  for (const [tt, on] of track.load) if (tt <= t) v = on; else break;
  return v;
};
export const deliveredBy = (dp: DayPlan, plant: string, t: number) =>
  (dp.drops.get(plant) ?? []).reduce((s, [tt, v]) => (tt <= t ? s + v : s), 0);
/** 0 before the machine arrives, 1 once it has left. */
export const progress = (w: Work | undefined, t: number) =>
  !w ? 0 : t <= w.t0 ? 0 : t >= w.t1 ? 1 : (t - w.t0) / (w.t1 - w.t0 || 1);

/** A machine works a field in back-and-forth passes; the cleared strip grows behind it. */
export const PASSES = 5;
export function sweep(cell: { x: number; z: number; w: number; d: number }, p: number, out: { x: number; z: number; dir: number; pass: number; along: number }) {
  const q = Math.min(Math.max(p, 0) * PASSES, PASSES - 1e-4);
  const pass = Math.floor(q), along = q - pass;
  const w = cell.w * 0.94, d = cell.d * 0.94;
  const north = pass % 2 === 0; // even passes head north (−z)
  out.pass = pass; out.along = along; out.dir = north ? -1 : 1;
  out.x = cell.x - w / 2 + ((pass + 0.5) * w) / PASSES;
  out.z = north ? cell.z + d / 2 - along * d : cell.z - d / 2 + along * d;
}
