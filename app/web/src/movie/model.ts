/**
 * Turns live API data into a time-indexed "world": every machine gets a list of legs (drive / work /
 * load / unload / idle) on the plan's real arrive & depart times, and every field gets its phase
 * timeline. Nothing here is scripted — a new plan builds a new film.
 */
import type { FC, Meta } from "../api";
import { along, bbox, centroid, clamp, dist, minutesOf, polyLength, Projector, type V2 } from "./geo";
import { RoadNet, type RoadsFC, type RoadWay } from "./roadnet";

export type MachineType = "baler_set" | "seeder" | "truck";

export type PlanJSON = {
  plan_id: string; date: string; policy: string;
  assignments: { machine_id: string; type: MachineType; stops: { field_id: string; arrive: string; depart: string; tonnes: number; method: "bale" | "seed" }[]; deliveries: { plant_id: string; tonnes: number; arrive: string }[] }[];
  unassigned: { field_id: string; reason: string }[];
  fields: { field_id: string; priority: number; route: string; route_reason: string }[];
  totals: { tonnes_planned: number; fields_planned: number; fields_at_risk: number };
};
export type RoutesFC = { features: { geometry: { coordinates: number[][] }; properties: { machine_id: string; source: string } }[] };
export type MachineRow = { machine_id: string; type: MachineType; base: [number, number]; operator_name?: string; village_name?: string; available?: boolean };
export type SupplyJSON = { plants: { plant_id: string; name: string; fill_t: number; depot_capacity_t: number; weekly_capacity_t: number; alert: boolean }[] };

export type Leg =
  | { kind: "idle"; t0: number; t1: number; at: V2 }
  | { kind: "drive"; t0: number; t1: number; path: V2[]; loaded?: boolean }
  | { kind: "work"; t0: number; t1: number; fieldId: string; path: V2[]; method: "bale" | "seed" }
  | { kind: "load"; t0: number; t1: number; at: V2; fieldId: string; tonnes: number }
  | { kind: "unload"; t0: number; t1: number; at: V2; plantId: string; tonnes: number };

export type MachineM = {
  id: string; type: MachineType; color: string; accent: string; operator: string; base: V2; legs: Leg[];
  stops: { fieldId: string; arrive: number; depart: number; method?: string }[];
};

export type FieldM = {
  id: string; village: string; villageName: string; ring: V2[]; center: V2; box: ReturnType<typeof bbox>;
  status: string; route?: string; straw: number; p50?: string; source?: string;
  work?: { machineId: string; t0: number; t1: number; method: "bale" | "seed"; passes: number };
  pickups: number[]; // minutes when a truck loads straw from this field
};

export type PlantM = { id: string; name: string; pos: V2; fill: number; depot: number; deliveries: { t: number; tonnes: number }[] };
export type VillageM = { id: string; name: string; pos: V2 };

export type World = {
  key: string; planId: string; date: string; policy: string; proj: Projector; deadline: string;
  fields: FieldM[]; fieldById: Map<string, FieldM>; machines: MachineM[]; plants: PlantM[]; villages: VillageM[];
  extent: ReturnType<typeof bbox>; dayStart: number; dayEnd: number; roads: RoadWay[]; roadSource: string;
  totals: PlanJSON["totals"]; unassigned: Map<string, string>;
};

// Each machine gets its own real-world-ish paint job (deterministic by id order).
const PAINT: Record<MachineType, [string, string][]> = {
  baler_set: [["#c8322a", "#f2c230"], ["#d4572a", "#f2c230"], ["#b8262f", "#ffd451"], ["#e0662b", "#f6d04d"]],
  seeder: [["#2f7d3a", "#f08a24"], ["#1f6a8a", "#f08a24"], ["#3b8f46", "#e85d2a"], ["#24788f", "#ef7f2c"]],
  truck: [["#1f5fb8", "#3aa3d6"], ["#7a3fb0", "#56b6e0"], ["#1b7f9c", "#46a8e0"], ["#2c4fa6", "#62b5ea"]],
};

const SPEED_M_PER_MIN = (25 * 1000) / 60 / 1.3; // matches planner travel: 25 km/h with 1.3 road factor

function serpentine(f: FieldM, passes: number): V2[] {
  const { x0, x1, z0, z1 } = f.box;
  const inset = Math.min(f.box.w, f.box.h) * 0.08;
  const pts: V2[] = [];
  for (let i = 0; i < passes; i++) {
    const z = z0 + inset + ((z1 - z0 - 2 * inset) * (i + 0.5)) / passes;
    const a: V2 = [x0 + inset, z], b: V2 = [x1 - inset, z];
    if (i % 2) pts.push(b, a); else pts.push(a, b);
  }
  return pts;
}

/** Cut a machine's road route into per-stop pieces by snapping each stop to the nearest vertex. */
function splitRoute(route: V2[] | undefined, waypoints: V2[]): V2[][] {
  const out: V2[][] = [];
  if (!route || route.length < 2) {
    for (let i = 1; i < waypoints.length; i++) out.push([waypoints[i - 1], waypoints[i]]);
    return out;
  }
  let last = 0;
  for (let i = 1; i < waypoints.length; i++) {
    let best = last, bd = Infinity;
    for (let j = last; j < route.length; j++) {
      const d = dist(route[j], waypoints[i]);
      if (d < bd) { bd = d; best = j; }
    }
    const seg = route.slice(last, best + 1);
    out.push([waypoints[i - 1], ...seg, waypoints[i]]);
    last = best;
  }
  return out;
}

let netCache: { key: string; net: RoadNet } | null = null;

export function buildWorld(args: {
  meta: Meta; fields: FC; plan: PlanJSON | null; routes: RoutesFC | null; machines: MachineRow[]; supply: SupplyJSON | null; roads: RoadsFC | null;
}): World {
  const { meta, fields, plan, routes, machines, supply, roads } = args;
  const villagesRaw = meta.villages;
  const lon0 = villagesRaw.reduce((s, v) => s + v.geometry.coordinates[0], 0) / Math.max(1, villagesRaw.length);
  const lat0 = villagesRaw.reduce((s, v) => s + v.geometry.coordinates[1], 0) / Math.max(1, villagesRaw.length);
  const proj = new Projector(lon0 || 75.74, lat0 || 30.36);

  const netKey = `${proj.lon0.toFixed(5)},${proj.lat0.toFixed(5)},${roads?.features.length ?? 0}`;
  if (roads && netCache?.key !== netKey) netCache = { key: netKey, net: new RoadNet(roads, proj) };
  const net = roads ? netCache!.net : null;
  const amazon = (routes?.features ?? []).some((f) => f.properties.source === "amazon-location");
  /** Road path between two points: Amazon Location geometry if the API gave it, else OSM routing, else straight. */
  const roadPath = (a: V2, b: V2, amazonPiece?: V2[]): V2[] => {
    if (amazon && amazonPiece && amazonPiece.length > 2) return amazonPiece;
    return net ? net.route(a, b) : [a, b];
  };

  const villages: VillageM[] = villagesRaw.map((v) => ({ id: v.properties.village_id, name: v.properties.name, pos: proj.to(v.geometry.coordinates) }));
  const fieldList: FieldM[] = fields.features.map((f) => {
    const ring = ((f.geometry as GeoJSON.Polygon).coordinates[0] as number[][]).map((c) => proj.to(c));
    const p = f.properties;
    return {
      id: p.field_id, village: p.village_id, villageName: p.village_name, ring, center: centroid(ring), box: bbox(ring),
      status: p.status, route: p.route, straw: p.straw_t, p50: p.harvest_window?.p50, source: p.harvest_window?.source, pickups: [],
    };
  });
  const fieldById = new Map(fieldList.map((f) => [f.id, f]));

  const rowsByType = new Map<MachineType, number>();
  const baseOf = new Map(machines.map((m) => [m.machine_id, proj.to(m.base)]));
  const routeOf = new Map((routes?.features ?? []).map((r) => [r.properties.machine_id, r.geometry.coordinates.map((c) => proj.to(c))]));
  const plantPos = new Map(meta.plants.map((p) => [p.plant_id, proj.to(p.location)]));

  const ms: MachineM[] = [];
  const deliveriesByPlant = new Map<string, { t: number; tonnes: number }[]>();
  let dayStart = 8 * 60, dayEnd = 17 * 60;

  const sortedMachines = [...machines].sort((a, b) => a.machine_id.localeCompare(b.machine_id));
  const assignments = new Map((plan?.assignments ?? []).map((a) => [a.machine_id, a]));
  for (const row of sortedMachines) {
    const k = rowsByType.get(row.type) ?? 0;
    rowsByType.set(row.type, k + 1);
    const [color, accent] = PAINT[row.type][k % PAINT[row.type].length];
    const base = baseOf.get(row.machine_id) ?? [0, 0];
    const a = assignments.get(row.machine_id);
    const legs: Leg[] = [];
    const stops: MachineM["stops"] = [];
    if (a && a.type !== "truck" && a.stops.length) {
      const waypoints: V2[] = [base, ...a.stops.map((s) => fieldById.get(s.field_id)?.center ?? base)];
      const amazonPieces = splitRoute(routeOf.get(row.machine_id), waypoints);
      let from = base;
      let cursor = -1e9;
      a.stops.forEach((s, i) => {
        const arrive = minutesOf(s.arrive), depart = minutesOf(s.depart);
        const f = fieldById.get(s.field_id);
        const passes = f ? clamp(Math.round(Math.min(f.box.w, f.box.h) / 16), 4, 9) : 4;
        const workPath = f ? serpentine(f, passes) : [from];
        const drive = roadPath(from, workPath[0], amazonPieces[i]);
        if (cursor === -1e9) {
          cursor = arrive - polyLength(drive) / SPEED_M_PER_MIN;
          legs.push({ kind: "idle", t0: -1e9, t1: cursor, at: base });
        }
        const t0 = Math.min(Math.max(cursor, arrive - polyLength(drive) / SPEED_M_PER_MIN), arrive);
        if (t0 > cursor) legs.push({ kind: "idle", t0: cursor, t1: t0, at: drive[0] });
        legs.push({ kind: "drive", t0, t1: arrive, path: drive });
        if (f) {
          legs.push({ kind: "work", t0: arrive, t1: depart, fieldId: f.id, path: workPath, method: s.method });
          f.work = { machineId: row.machine_id, t0: arrive, t1: depart, method: s.method, passes };
        }
        from = workPath[workPath.length - 1];
        stops.push({ fieldId: s.field_id, arrive, depart, method: s.method });
        cursor = depart;
        dayStart = Math.min(dayStart, t0);
        dayEnd = Math.max(dayEnd, depart);
      });
      legs.push({ kind: "idle", t0: cursor, t1: 1e9, at: (legs[legs.length - 1] as { path: V2[] }).path?.slice(-1)[0] ?? base });
    } else if (a && a.type === "truck" && a.stops.length) {
      let here = base;
      let cursor = -1e9;
      a.stops.forEach((s, i) => {
        const f = fieldById.get(s.field_id);
        const pick = minutesOf(s.arrive);
        const at = f?.center ?? here;
        const d = a.deliveries[i];
        const plant = d ? plantPos.get(d.plant_id) ?? at : at;
        const inPath = roadPath(here, at);
        const driveIn = polyLength(inPath) / SPEED_M_PER_MIN;
        const t0 = Math.max(cursor, pick - driveIn);
        if (cursor > -1e9 && t0 > cursor) legs.push({ kind: "idle", t0: cursor, t1: t0, at: here });
        else if (cursor === -1e9) legs.push({ kind: "idle", t0: -1e9, t1: t0, at: here });
        legs.push({ kind: "drive", t0, t1: pick, path: inPath });
        const loadEnd = pick + 12;
        legs.push({ kind: "load", t0: pick, t1: loadEnd, at, fieldId: s.field_id, tonnes: s.tonnes });
        f?.pickups.push(pick);
        const outPath = roadPath(at, plant);
        // the plan's arrival assumed straight-line travel; on real roads the trolley may need longer
        const arrive = d ? Math.max(minutesOf(d.arrive), loadEnd + polyLength(outPath) / (SPEED_M_PER_MIN * 1.6)) : loadEnd;
        legs.push({ kind: "drive", t0: loadEnd, t1: arrive, path: outPath, loaded: true });
        legs.push({ kind: "unload", t0: arrive, t1: arrive + 10, at: plant, plantId: d?.plant_id ?? "", tonnes: s.tonnes });
        if (d) {
          const list = deliveriesByPlant.get(d.plant_id) ?? [];
          list.push({ t: arrive + 10, tonnes: d.tonnes });
          deliveriesByPlant.set(d.plant_id, list);
        }
        here = plant;
        cursor = arrive + 10;
        stops.push({ fieldId: s.field_id, arrive: pick, depart: loadEnd });
        dayStart = Math.min(dayStart, t0);
        dayEnd = Math.max(dayEnd, cursor);
      });
      legs.push({ kind: "idle", t0: cursor, t1: 1e9, at: here });
    } else {
      legs.push({ kind: "idle", t0: -1e9, t1: 1e9, at: base });
    }
    ms.push({ id: row.machine_id, type: row.type, color, accent, operator: row.operator_name ?? row.machine_id, base, legs, stops });
  }

  const supplyBy = new Map((supply?.plants ?? []).map((p) => [p.plant_id, p]));
  const plants: PlantM[] = meta.plants.map((p) => ({
    id: p.plant_id, name: p.name, pos: proj.to(p.location),
    fill: supplyBy.get(p.plant_id)?.fill_t ?? p.fill_t, depot: p.depot_capacity_t,
    deliveries: (deliveriesByPlant.get(p.plant_id) ?? []).sort((a, b) => a.t - b.t),
  }));

  const pts: V2[] = [...fieldList.flatMap((f) => f.ring), ...villages.map((v) => v.pos)];
  return {
    key: `${plan?.plan_id ?? "noplan"}|${fields.features.map((f) => f.properties.status[0]).join("")}`,
    planId: plan?.plan_id ?? "", date: fields.date, policy: plan?.policy ?? "strawlink", proj,
    deadline: String(meta.params.sowing_deadline_default ?? ""),
    fields: fieldList, fieldById, machines: ms, plants, villages, extent: bbox(pts),
    roads: net?.ways ?? [], roadSource: amazon ? "Amazon Location Service" : net ? "OpenStreetMap" : "straight lines",
    dayStart: Math.floor((dayStart - 30) / 15) * 15, dayEnd: Math.ceil((dayEnd + 30) / 15) * 15,
    totals: plan?.totals ?? { tonnes_planned: 0, fields_planned: 0, fields_at_risk: 0 },
    unassigned: new Map((plan?.unassigned ?? []).map((u) => [u.field_id, u.reason])),
  };
}

// ---------------------------------------------------------------- queries at sim time t (minutes)

export type Pose = { pos: V2; heading: number; activity: Leg["kind"]; leg: Leg; progress: number; loaded: boolean };

export function poseAt(m: MachineM, t: number): Pose {
  const legs = m.legs;
  let leg = legs[legs.length - 1];
  for (const l of legs) if (t >= l.t0 && t < l.t1) { leg = l; break; }
  const p = leg.t1 > leg.t0 && Math.abs(leg.t1) < 1e8 && Math.abs(leg.t0) < 1e8 ? clamp((t - leg.t0) / (leg.t1 - leg.t0), 0, 1) : 0;
  const loadedNow = (l: Leg) => l.kind === "unload" || (l.kind === "drive" && !!l.loaded);
  if (leg.kind === "drive" || leg.kind === "work") {
    const a = along(leg.path, p);
    return { pos: a.pos, heading: a.heading, activity: leg.kind, leg, progress: p, loaded: loadedNow(leg) };
  }
  // keep the heading of the previous moving leg while parked
  const idx = legs.indexOf(leg);
  let heading = 0;
  for (let i = idx - 1; i >= 0; i--) {
    const l = legs[i];
    if (l.kind === "drive" || l.kind === "work") { heading = along(l.path, 1).heading; break; }
  }
  return { pos: leg.at, heading, activity: leg.kind, leg, progress: p, loaded: leg.kind === "unload" || (leg.kind === "load" && p > 0.5) };
}

export type FieldPhase = "standing" | "ripe" | "stubble" | "working" | "baled" | "seeded" | "cleared" | "wet" | "risk";

/** Visual phase of a field at sim time t, and work progress 0..1 when a machine is on it. */
export function fieldPhaseAt(f: FieldM, t: number, date: string): { phase: FieldPhase; progress: number } {
  if (f.status === "cleared") return { phase: "cleared", progress: 1 };
  if (f.work) {
    if (t >= f.work.t1) {
      if (f.work.method === "seed") return { phase: "seeded", progress: 1 };
      const picked = f.pickups.length && f.pickups.every((pk) => t >= pk + 12);
      return { phase: picked ? "cleared" : "baled", progress: 1 };
    }
    if (t >= f.work.t0) return { phase: "working", progress: (t - f.work.t0) / (f.work.t1 - f.work.t0) };
  }
  if (f.status === "wet") return { phase: "wet", progress: 0 };
  if (f.status === "at_risk") return { phase: "risk", progress: 0 };
  if (f.status === "forecast") {
    const days = f.p50 ? (Date.parse(f.p50) - Date.parse(date)) / 86400000 : 7;
    return { phase: days > 3 ? "standing" : "ripe", progress: clamp(1 - days / 10, 0, 1) };
  }
  return { phase: "stubble", progress: 0 };
}

export function plantFillAt(p: PlantM, t: number) {
  let fill = p.fill;
  for (const d of p.deliveries) if (t >= d.t) fill += d.tonnes;
  return fill;
}
