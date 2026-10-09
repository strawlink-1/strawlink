import type { FC, FieldProps } from "../api";

/** Scene units: 1 unit = 100 m. x = east, z = south, y = up. */
export const M_PER_UNIT = 100;
export type XZ = [number, number];
export type LonLat = [number, number];
export type Projector = (lonLat: LonLat) => XZ;
export type Box = { x0: number; x1: number; z0: number; z1: number };
export type Cell = { i: number; id: string; x: number; z: number; w: number; d: number; props: FieldProps };
export type Geo = { project: Projector; box: Box; span: number; bbox: [number, number, number, number] };

/** Local flat projection centred on the fields (fine over a ~10 km block). */
export function makeGeo(fc: FC): Geo {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const f of fc.features) for (const c of (f.geometry as GeoJSON.Polygon).coordinates[0]) {
    w = Math.min(w, c[0]); e = Math.max(e, c[0]); s = Math.min(s, c[1]); n = Math.max(n, c[1]);
  }
  const lon0 = (w + e) / 2, lat0 = (s + n) / 2;
  const kx = (111_320 * Math.cos((lat0 * Math.PI) / 180)) / M_PER_UNIT;
  const kz = 110_574 / M_PER_UNIT;
  const project: Projector = ([lon, lat]) => [(lon - lon0) * kx, -(lat - lat0) * kz];
  const [x0, z1] = project([w, s]);
  const [x1, z0] = project([e, n]);
  const pad = 5; // half a kilometre of land around the outermost fields
  const box = { x0: x0 - pad, x1: x1 + pad, z0: z0 - pad, z1: z1 + pad };
  return { project, box, span: Math.max(box.x1 - box.x0, box.z1 - box.z0), bbox: [w, s, e, n] };
}

/** Parcels are near-rectangular grid cells: each is drawn over its bounding rectangle. */
export function toCells(fc: FC, project: Projector): Cell[] {
  return fc.features.map((f, i) => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const c of (f.geometry as GeoJSON.Polygon).coordinates[0]) {
      const [x, z] = project(c as LonLat);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
    }
    return { i, id: f.properties.field_id, x: (x0 + x1) / 2, z: (z0 + z1) / 2, w: x1 - x0, d: z1 - z0, props: f.properties };
  });
}

/**
 * Things far outside the block (plants 15–25 km away, downwind places) are drawn at their true
 * bearing but just beyond the block's edge; their labels always carry the real distance.
 */
export function pullIn([x, z]: XZ, box: Box, gap = 9): { at: XZ; realKm: number; moved: boolean } {
  const realKm = (Math.hypot(x, z) * M_PER_UNIT) / 1000;
  const hx = (box.x1 - box.x0) / 2 + gap, hz = (box.z1 - box.z0) / 2 + gap;
  const cx = (box.x0 + box.x1) / 2, cz = (box.z0 + box.z1) / 2;
  const dx = x - cx, dz = z - cz;
  const k = Math.max(Math.abs(dx) / hx, Math.abs(dz) / hz);
  if (k <= 1) return { at: [x, z], realKm, moved: false };
  return { at: [cx + dx / k, cz + dz / k], realKm, moved: true };
}

/** The stretches of a line that lie on the board. */
export function clip(pts: XZ[], b: Box, inset = 0.4): XZ[][] {
  const out: XZ[][] = [];
  let run: XZ[] = [];
  for (const p of pts) {
    if (p[0] >= b.x0 + inset && p[0] <= b.x1 - inset && p[1] >= b.z0 + inset && p[1] <= b.z1 - inset) run.push(p);
    else { if (run.length > 1) out.push(run); run = []; }
  }
  if (run.length > 1) out.push(run);
  return out;
}

/** Convex hull (monotone chain) — the outline drawn around each village's fields. */
export function hull(points: XZ[]): XZ[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: XZ, a: XZ, b: XZ) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: XZ[] = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  const upper: XZ[] = [];
  for (const q of p.reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Small deterministic random generator: the scenery must look the same on every load. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
