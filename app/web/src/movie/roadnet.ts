/**
 * Road network from OpenStreetMap ways + shortest-time routing for tractors and trolleys.
 * Edge cost = length / tractor speed for the road class. Expressways are excluded (no tractors).
 */
import { dist, polyLength, type Projector, type V2 } from "./geo";

export type RoadClass = "major" | "minor" | "village" | "track";
export type RoadWay = { cls: RoadClass; highway: string; name: string; pts: V2[] };

const SPEED_KMH: Record<string, number> = {
  trunk: 32, trunk_link: 28, primary: 30, primary_link: 26, secondary: 28, secondary_link: 24,
  tertiary: 25, tertiary_link: 22, unclassified: 22, road: 20, residential: 15, living_street: 10, service: 12, track: 12,
};

export function classOf(highway: string): RoadClass {
  if (/^(trunk|primary|secondary)/.test(highway)) return "major";
  if (/^(tertiary|unclassified|road)/.test(highway)) return "minor";
  if (/^(residential|living_street|service)/.test(highway)) return "village";
  return "track";
}

class Heap {
  private a: [number, number][] = [];
  get size() { return this.a.length; }
  push(n: number, p: number) {
    const a = this.a;
    a.push([p, n]);
    let i = a.length - 1;
    while (i > 0) {
      const j = (i - 1) >> 1;
      if (a[j][0] <= a[i][0]) break;
      [a[i], a[j]] = [a[j], a[i]];
      i = j;
    }
  }
  pop(): [number, number] {
    const a = this.a;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

export class RoadNet {
  readonly ways: RoadWay[] = [];
  private xy: V2[] = [];
  private adj: { to: number; cost: number }[][] = [];
  private grid = new Map<string, number[]>();
  private cell = 250;
  private cache = new Map<string, V2[]>();

  constructor(fc: RoadsFC, proj: Projector) {
    const ids = new Map<string, number>();
    const node = (lon: number, lat: number) => {
      const key = `${lon.toFixed(6)},${lat.toFixed(6)}`;
      let id = ids.get(key);
      if (id === undefined) {
        id = this.xy.length;
        ids.set(key, id);
        this.xy.push(proj.to([lon, lat]));
        this.adj.push([]);
      }
      return id;
    };
    for (const f of fc.features) {
      const hw = f.properties.highway;
      const coords = f.geometry.coordinates;
      if (coords.length < 2) continue;
      this.ways.push({ cls: classOf(hw), highway: hw, name: f.properties.name ?? "", pts: coords.map((c) => proj.to(c)) });
      const speed = SPEED_KMH[hw];
      if (!speed) continue; // motorways and unknown classes: drawn, never routed on
      const mPerMin = (speed * 1000) / 60;
      let prev = node(coords[0][0], coords[0][1]);
      for (let i = 1; i < coords.length; i++) {
        const cur = node(coords[i][0], coords[i][1]);
        const cost = dist(this.xy[prev], this.xy[cur]) / mPerMin;
        this.adj[prev].push({ to: cur, cost });
        this.adj[cur].push({ to: prev, cost });
        prev = cur;
      }
    }
    this.xy.forEach((p, i) => {
      if (!this.adj[i].length) return;
      const k = this.key(p);
      (this.grid.get(k) ?? this.grid.set(k, []).get(k)!).push(i);
    });
  }

  private key(p: V2, dx = 0, dz = 0) {
    return `${Math.floor(p[0] / this.cell) + dx},${Math.floor(p[1] / this.cell) + dz}`;
  }

  /** Nearest routable node (searches outward ring by ring). */
  nearest(p: V2, maxRings = 12): number | null {
    let best: number | null = null, bd = Infinity;
    for (let r = 0; r <= maxRings; r++) {
      for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        for (const i of this.grid.get(this.key(p, dx, dz)) ?? []) {
          const d = dist(p, this.xy[i]);
          if (d < bd) { bd = d; best = i; }
        }
      }
      if (best !== null && bd < r * this.cell) break;
    }
    return best;
  }

  /** Road path from a to b (with the off-road access legs at both ends); straight line if unreachable. */
  route(a: V2, b: V2): V2[] {
    const ck = `${a[0].toFixed(0)},${a[1].toFixed(0)}>${b[0].toFixed(0)},${b[1].toFixed(0)}`;
    const hit = this.cache.get(ck);
    if (hit) return hit;
    const s = this.nearest(a), t = this.nearest(b);
    let out: V2[] = [a, b];
    if (s !== null && t !== null && s !== t) {
      const n = this.xy.length;
      const best = new Float64Array(n).fill(Infinity);
      const prev = new Int32Array(n).fill(-1);
      const heap = new Heap();
      best[s] = 0;
      heap.push(s, 0);
      const tx = this.xy[t];
      const maxSpeed = (32 * 1000) / 60;
      while (heap.size) {
        const [, u] = heap.pop();
        if (u === t) break;
        for (const e of this.adj[u]) {
          const c = best[u] + e.cost;
          if (c < best[e.to]) {
            best[e.to] = c;
            prev[e.to] = u;
            heap.push(e.to, c + dist(this.xy[e.to], tx) / maxSpeed); // A* with admissible heuristic
          }
        }
      }
      if (prev[t] !== -1) {
        const nodes: V2[] = [];
        for (let u = t; u !== -1; u = prev[u]) nodes.push(this.xy[u]);
        nodes.reverse();
        out = [a, ...nodes, b];
      }
    } else if (s !== null && s === t) {
      out = [a, this.xy[s], b];
    }
    this.cache.set(ck, out);
    return out;
  }

  length(p: V2[]) {
    return polyLength(p);
  }
}

export type RoadsFC = { features: { geometry: { coordinates: number[][] }; properties: { highway: string; name?: string } }[] };

let roadsPromise: Promise<RoadsFC | null> | null = null;
/** OSM roads exported by app/tools/load_osm.py into public/osm/ (fetched once). */
export function loadRoads(): Promise<RoadsFC | null> {
  roadsPromise ??= fetch("/osm/roads.geojson").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return roadsPromise;
}
