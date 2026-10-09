import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { post, type FC, type Meta, type Status } from "../api";
import { useApp, useFetch } from "../state";
import { buildDayPlan, type DayPlan, type MachineType, type Plan } from "./dayplan";
import { clip, hull, makeGeo, pullIn, toCells, type Cell, type Geo, type LonLat, type XZ } from "./geo";
import { RoadGraph, type RoadLine } from "./roads";

export type Clock = { t: number; playing: boolean; speed: number };
export type PlantView = { id: string; name: string; at: XZ; exit: XZ; realKm: number; capacity: number; fill: number; weekly: number };
export type VillageView = { id: string; name: string; namePa?: string; centre: XZ; mid: XZ; r: number; hull: XZ[]; fields: number; wet: boolean };
export type Pulse = { key: string; x: number; z: number; color: string };

/** What the person at the controls has set. Every change is sent to the planner. */
export type Inputs = {
  date: string;
  baler_set: number;
  seeder: number;
  truck: number;
  rain_mm: number;
  rain_village: string;
  /** fields a farmer has confirmed as harvested today */
  confirmed: string[];
};
/** POST /simulate: the planner's answer for one set of inputs. Nothing is stored on the server. */
export type SimResult = {
  date: string;
  plan: Plan;
  status: Record<string, Status>;
  machines: { machine_id: string; type: MachineType; base: LonLat }[];
  inputs: { fleet: Record<MachineType, number>; rain_wet_threshold_mm: number; time_limit_s: number };
};

type Machines = { machines: { machine_id: string; type: string }[] };
type Roads = { roads: GeoJSON.FeatureCollection; water: GeoJSON.FeatureCollection };

export type World = {
  ready: boolean;
  error: string | null;
  meta: Meta | null;
  /** the plan day the API was started with */
  today: string;
  inputs: Inputs;
  setInputs: (patch: Partial<Inputs>) => void;
  resetInputs: () => void;
  defaults: Inputs | null;
  /** true while the planner is working on the latest inputs */
  planning: boolean;
  simError: string | null;
  sim: SimResult | null;
  geo: Geo | null;
  cells: Cell[];
  cellById: Map<string, Cell>;
  roads: RoadLine[];
  water: RoadLine[];
  plants: PlantView[];
  villages: VillageView[];
  plan: Plan | null;
  day: DayPlan | null;
  /** every machine in the simulated fleet, in a fixed order; `slot` spreads machines that share a base */
  fleet: { id: string; type: MachineType; at: XZ; slot: number; works: boolean }[];
  clock: MutableRefObject<Clock>;
  /** where each machine is right now; written by the scene, read by the camera */
  vehiclePos: MutableRefObject<Map<string, { x: number; z: number }>>;
  pulses: Pulse[];
  selected: string | null;
  select: (id: string | null) => void;
  follow: string | null;
  setFollow: (id: string | null) => void;
  toast: { text: string; key: number } | null;
  say: (text: string) => void;
  refresh: () => void;
};

const Ctx = createContext<World | null>(null);
const POLL_MS = 15000;
const DEBOUNCE_MS = 450;
export const DEFAULT_SPEED = 4; // plan-minutes per second: slow enough to watch a truck drive a road

const toLines = (fc: GeoJSON.FeatureCollection | undefined, geo: Geo): RoadLine[] =>
  (fc?.features ?? []).flatMap((f) =>
    clip((f.geometry as GeoJSON.LineString).coordinates.map((c) => geo.project(c as LonLat)), geo.box)
      .map((pts) => ({ kind: String(f.properties?.kind ?? ""), pts })));

export function WorldProvider({ children }: { children: ReactNode }) {
  const { meta, metaError, date: today, version, bump } = useApp();
  const [inputs, setAll] = useState<Inputs>({ date: "", baler_set: 3, seeder: 3, truck: 3, rain_mm: 0, rain_village: "all", confirmed: [] });
  const [defaults, setDefaults] = useState<Inputs | null>(null);
  const [sim, setSim] = useState<SimResult | null>(null);
  const [planning, setPlanning] = useState(false);
  const [simError, setSimError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [selected, select] = useState<string | null>(null);
  const [follow, setFollow] = useState<string | null>(null);
  const [toast, setToast] = useState<World["toast"]>(null);
  const say = useCallback((text: string) => setToast({ text, key: Date.now() }), []);
  const setInputs = useCallback((patch: Partial<Inputs>) => setAll((cur) => ({ ...cur, ...patch })), []);
  const resetInputs = useCallback(() => { if (defaults) setAll(defaults); }, [defaults]);

  // the controls start at the real fleet and the API's plan day
  const fleet = useFetch<Machines>("/machines", []);
  useEffect(() => {
    if (defaults || !today || !fleet.data) return;
    const n = (t: string) => fleet.data!.machines.filter((m) => m.type === t).length;
    const start: Inputs = { date: today, baler_set: n("baler_set"), seeder: n("seeder"), truck: n("truck"), rain_mm: 0, rain_village: "all", confirmed: [] };
    setDefaults(start);
    setAll(start);
  }, [defaults, today, fleet.data]);

  // ask the planner whenever the inputs settle (or the stored data changes)
  const planned = useRef<number | null>(null);
  const key = JSON.stringify(inputs);
  useEffect(() => {
    if (!defaults || !inputs.date) return;
    let live = true;
    const id = setTimeout(async () => {
      setPlanning(true);
      try {
        const r = await post<SimResult>("/simulate", inputs);
        if (live) {
          const n = r.plan.totals.fields_planned, was = planned.current;
          planned.current = n;
          if (was !== null) say(n === was ? `New plan: still ${n} fields cleared today` : `New plan: ${n} fields cleared today (${n > was ? "+" : "\u2212"}${Math.abs(n - was)})`);
          setSim(r); setSimError(null);
        }
      } catch (e) {
        if (live) setSimError(String((e as Error).message ?? e).slice(0, 200));
      } finally {
        if (live) setPlanning(false);
      }
    }, DEBOUNCE_MS);
    return () => { live = false; clearTimeout(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, !!defaults, version]);

  // field data (forecasts, confirmations) is re-read now and then; a WhatsApp confirmation shows up by itself
  useEffect(() => {
    const id = setInterval(() => !document.hidden && setTick((t) => t + 1), POLL_MS);
    return () => clearInterval(id);
  }, []);
  const fields = useFetch<FC>(inputs.date ? `/fields?date=${inputs.date}` : null, [version, tick]);
  const roadsReq = useFetch<Roads>("/roads", []);

  const fc = fields.data;
  // field geometry never changes during a session; re-projecting would make the scene jump
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const geo = useMemo(() => (fc?.features.length ? makeGeo(fc) : null), [fc?.features.length]);
  // each field's status is the planner's for the current inputs, once it has answered for this day
  const cells = useMemo(() => {
    if (!fc || !geo) return [];
    const status = sim && sim.date === fc.date ? sim.status : null;
    return toCells(fc, geo.project).map((c) => (status?.[c.id] ? { ...c, props: { ...c.props, status: status[c.id] } } : c));
  }, [fc, geo, sim]);
  const cellById = useMemo(() => new Map(cells.map((c) => [c.id, c])), [cells]);

  const roads = useMemo(() => (geo ? toLines(roadsReq.data?.roads, geo) : []), [geo, roadsReq.data]);
  const water = useMemo(() => (geo ? toLines(roadsReq.data?.water, geo) : []), [geo, roadsReq.data]);
  const graph = useMemo(() => (roads.length ? new RoadGraph(roads) : null), [roads]);

  const plants = useMemo<PlantView[]>(() => {
    if (!geo || !meta) return [];
    return meta.plants.map((p) => {
      const c = pullIn(geo.project(p.location), geo.box);
      const n = graph?.nearest(c.at) ?? -1;
      return {
        id: p.plant_id, name: p.name.replace(" (synthetic)", ""), at: c.at, exit: n >= 0 ? graph!.at(n) : [c.at[0] * 0.8, c.at[1] * 0.8],
        realKm: c.realKm, capacity: p.depot_capacity_t, fill: p.fill_t, weekly: p.weekly_capacity_t,
      };
    });
  }, [geo, meta, graph]);

  const wetKey = [...new Set(cells.filter((c) => c.props.status === "wet").map((c) => c.props.village_id))].sort().join(",");
  const villages = useMemo<VillageView[]>(() => {
    if (!geo || !meta) return [];
    const wet = new Set(wetKey.split(","));
    return meta.villages.map((v) => {
      const mine = cells.filter((c) => c.props.village_id === v.properties.village_id);
      const pts = mine.flatMap((c) => [[c.x - c.w, c.z - c.d], [c.x + c.w, c.z - c.d], [c.x + c.w, c.z + c.d], [c.x - c.w, c.z + c.d]] as XZ[]);
      const mx = mine.reduce((s, c) => s + c.x, 0) / (mine.length || 1), mz = mine.reduce((s, c) => s + c.z, 0) / (mine.length || 1);
      return {
        id: v.properties.village_id, name: v.properties.name, namePa: v.properties.name_pa || undefined,
        centre: geo.project(v.geometry.coordinates), mid: [mx, mz], hull: hull(pts), fields: mine.length,
        r: Math.max(6, ...mine.map((c) => Math.hypot(c.x - mx, c.z - mz))) + 2, wet: wet.has(v.properties.village_id),
      };
    });
    // village membership is static; cells is re-created on every refresh
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geo, meta, cells.length, wetKey]);

  const plan = sim?.plan ?? null;
  const day = useMemo(() => {
    if (!geo || !sim || !cells.length) return null;
    const speed = Number(meta?.params.speed_kmh ?? 25);
    return buildDayPlan(sim.plan, {
      fieldAt: new Map(cells.map((c) => [c.id, [c.x, c.z] as XZ])),
      baseAt: new Map(sim.machines.map((m) => [m.machine_id, geo.project(m.base)])),
      plantAt: new Map(plants.map((p) => [p.id, p.at])),
      // drawn along the block's real roads; arrival and departure times are the planner's
      leg: (a, b) => graph?.path(a, b) ?? [a, b],
      unitsPerMin: (speed * 10) / 60, // km/h → scene units (100 m) per minute
    });
    // plan_id identifies the plan
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geo, sim?.plan.plan_id, cells.length, plants, graph]);

  const fleetView = useMemo(() => {
    if (!geo || !sim) return [];
    const busy = new Set(day?.tracks.map((t) => t.id));
    return sim.machines.map((m, slot) => ({ id: m.machine_id, type: m.type, at: geo.project(m.base), slot, works: busy.has(m.machine_id) }));
  }, [geo, sim, day]);

  // one clock for the scene and the time bar; a new plan starts its day from the morning
  const clock = useRef<Clock>({ t: 0, playing: false, speed: DEFAULT_SPEED });
  // a new plan keeps the time of day, so a slider moved mid-run shows the same moment under the new plan
  useEffect(() => {
    if (!day) return;
    const c = clock.current;
    c.t = c.t >= day.t1 - 0.5 ? day.t0 : Math.max(day.t0, c.t);
  }, [day]);
  const vehiclePos = useRef(new Map<string, { x: number; z: number }>());

  // a ring rises from every field whose status just changed, so a new plan is visible on the map
  const seen = useRef<Map<string, string> | null>(null);
  const [pulses, setPulses] = useState<Pulse[]>([]);
  useEffect(() => {
    if (!cells.length) return;
    const next = new Map(cells.map((c) => [c.id, c.props.status as string]));
    const prev = seen.current;
    seen.current = next;
    if (!prev) return;
    const changed = cells.filter((c) => prev.get(c.id) !== next.get(c.id));
    if (!changed.length || changed.length > 70) return; // a whole-map change needs no fireworks
    const stamp = Date.now();
    setPulses((p) => [...p.slice(-40), ...changed.map((c) => ({
      key: `${c.id}-${stamp}`, x: c.x, z: c.z,
      color: c.props.status === "wet" ? "#3b82f6" : c.props.status === "scheduled" ? "#1d4ed8" : c.props.status === "at_risk" ? "#dc2626" : "#f59e0b",
    }))]);
  }, [cells]);

  const world: World = {
    ready: !!geo && cells.length > 0 && !!meta,
    error: metaError ?? (fields.error && !fc ? fields.error : null),
    meta, today, inputs, setInputs, resetInputs, defaults, planning, simError, sim,
    geo, cells, cellById, roads, water, plants, villages, plan, day, fleet: fleetView, clock, vehiclePos, pulses,
    selected, select, follow, setFollow, toast, say, refresh: bump,
  };
  return <Ctx.Provider value={world}>{children}</Ctx.Provider>;
}

export function useWorld() {
  const w = useContext(Ctx);
  if (!w) throw new Error("useWorld outside WorldProvider");
  return w;
}
