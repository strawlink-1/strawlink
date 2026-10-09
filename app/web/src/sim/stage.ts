import { useEffect, useSyncExternalStore } from "react";
import type { Cell, XZ } from "./geo";

/** How a field is drawn. Looks are defined in scene/looks.ts. */
export type Look = "paddy" | "ripe" | "straw" | "sched" | "soil" | "seeded" | "risk" | "wet" | "burned" | "dim" | "bale" | "seed";

export type CameraSpec = {
  /** a new key makes the camera fly to this shot */
  key: string;
  target?: XZ;
  /** distance in scene units; default frames the whole block */
  dist?: number;
  /** tilt from straight-down, radians */
  polar?: number;
  azim?: number;
};

export type AirLayer = {
  /** direction the wind blows towards, degrees clockwise from north */
  windTo: number;
  sectorDeg: number;
  sources: XZ[];
  places: { name: string; kind: string; at: XZ; km: number; moved: boolean }[];
};

/**
 * What the shared 3D map should show right now. Each page publishes its own mode;
 * the map itself knows nothing about pages.
 */
export type StageMode = {
  look: (c: Cell) => Look;
  /** run the day: machines drive, fields change as they are worked */
  live: boolean;
  /** when set, every other field is dimmed */
  keep: Set<string> | null;
  /** a pin on one field (besides the user's own selection) */
  pin: string | null;
  smoke: XZ[];
  /** arcs for today's truck trips, field → plant */
  trips: boolean;
  air: AirLayer | null;
  plantLabels: boolean;
  villageLabels: boolean;
  camera: CameraSpec;
};

export const BASE: StageMode = {
  look: () => "straw",
  live: false,
  keep: null,
  pin: null,
  smoke: [],
  trips: false,
  air: null,
  plantLabels: false,
  villageLabels: true,
  camera: { key: "block" },
};

let mode: StageMode = BASE;
const subs = new Set<() => void>();

export const stage = {
  get: () => mode,
  set(next: Partial<StageMode>) {
    mode = { ...BASE, ...next };
    subs.forEach((f) => f());
  },
  subscribe(f: () => void) {
    subs.add(f);
    return () => { subs.delete(f); };
  },
};

export const useStage = () => useSyncExternalStore(stage.subscribe, stage.get);

/** A page declares what the map shows while it is on screen. */
export function useStageMode(build: () => Partial<StageMode>, deps: unknown[]) {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { stage.set(build()); }, deps);
}

/* ---- the "what is real, approximate and synthetic" sheet ---- */
let sheetOpen = false;
const sheetSubs = new Set<() => void>();
export const sheet = {
  get: () => sheetOpen,
  set(on: boolean) { sheetOpen = on; sheetSubs.forEach((f) => f()); },
  subscribe(f: () => void) { sheetSubs.add(f); return () => { sheetSubs.delete(f); }; },
};
export const useSheet = () => useSyncExternalStore(sheet.subscribe, sheet.get);
