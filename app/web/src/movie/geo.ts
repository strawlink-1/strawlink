/** Local metric projection + small geometry/time helpers for the 3D scene. 1 world unit = 1 metre. */

export type V2 = [number, number];

export class Projector {
  readonly lon0: number;
  readonly lat0: number;
  private kx: number;
  private ky = 110574;
  constructor(lon0: number, lat0: number) {
    this.lon0 = lon0;
    this.lat0 = lat0;
    this.kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  }
  /** lon/lat → scene (x east, z south). */
  to([lon, lat]: number[]): V2 {
    return [(lon - this.lon0) * this.kx, -(lat - this.lat0) * this.ky];
  }
}

export const dist = (a: V2, b: V2) => Math.hypot(b[0] - a[0], b[1] - a[1]);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
export const smooth = (t: number) => t * t * (3 - 2 * t);

export function polyLength(p: V2[]) {
  let s = 0;
  for (let i = 1; i < p.length; i++) s += dist(p[i - 1], p[i]);
  return s;
}

/** Point and heading at fraction f (0..1) along a polyline. */
export function along(p: V2[], f: number): { pos: V2; heading: number } {
  if (p.length === 1) return { pos: p[0], heading: 0 };
  const total = polyLength(p) || 1;
  let target = clamp(f, 0, 1) * total;
  for (let i = 1; i < p.length; i++) {
    const d = dist(p[i - 1], p[i]);
    if (target <= d || i === p.length - 1) {
      const t = d ? clamp(target / d, 0, 1) : 0;
      return {
        pos: [lerp(p[i - 1][0], p[i][0], t), lerp(p[i - 1][1], p[i][1], t)],
        heading: Math.atan2(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]),
      };
    }
    target -= d;
  }
  return { pos: p[p.length - 1], heading: 0 };
}

export function centroid(ring: V2[]): V2 {
  const pts = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring;
  let x = 0, z = 0;
  for (const p of pts) { x += p[0]; z += p[1]; }
  return [x / pts.length, z / pts.length];
}

export function bbox(points: V2[]) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const [x, z] of points) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
  return { x0, z0, x1, z1, w: x1 - x0, h: z1 - z0, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2 };
}

/** Deterministic PRNG so procedural scenery is stable between renders. */
export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

export function hash(str: string) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** "2026-10-24T08:01:00+05:30" → minutes after local midnight (IST wall clock). */
export const minutesOf = (iso: string) => Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16));
export const hhmm = (m: number) => {
  const mm = Math.max(0, Math.round(m));
  return `${String(Math.floor(mm / 60) % 24).padStart(2, "0")}:${String(mm % 60).padStart(2, "0")}`;
};
