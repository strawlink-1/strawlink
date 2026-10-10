import type { XZ } from "./geo";

export type RoadLine = { kind: string; pts: XZ[] };

const STEP = 0.6;   // split long road segments every 60 m so fields can join a road near them
const SNAP = 50;    // vertices within 2 m are the same junction
const GRID = 2;     // spatial index cell, 200 m

/**
 * The block's real road network (OpenStreetMap) as a graph, with shortest-path search.
 * Used only to draw where machines drive; the plan's times come from the planner.
 */
export class RoadGraph {
  private xs: number[] = [];
  private zs: number[] = [];
  private adj: number[][] = [];
  private len: number[][] = [];
  private grid = new Map<number, number[]>();
  private cache = new Map<number, XZ[]>();
  private g: Float64Array;
  private from: Int32Array;
  private stamp: Int32Array;
  private run = 0;

  constructor(lines: RoadLine[]) {
    const index = new Map<number, number>();
    const node = (x: number, z: number) => {
      const k = (Math.round(x * SNAP) + 50_000) * 100_000 + Math.round(z * SNAP) + 50_000;
      let i = index.get(k);
      if (i === undefined) {
        i = this.xs.length;
        index.set(k, i);
        this.xs.push(x); this.zs.push(z); this.adj.push([]); this.len.push([]);
      }
      return i;
    };
    const link = (a: number, b: number) => {
      if (a === b) return;
      const d = Math.hypot(this.xs[a] - this.xs[b], this.zs[a] - this.zs[b]);
      this.adj[a].push(b); this.len[a].push(d);
      this.adj[b].push(a); this.len[b].push(d);
    };
    for (const line of lines) {
      let prev = -1;
      for (let i = 0; i < line.pts.length; i++) {
        const [x, z] = line.pts[i];
        if (prev >= 0) {
          const px = this.xs[prev], pz = this.zs[prev];
          const n = Math.ceil(Math.hypot(x - px, z - pz) / STEP);
          for (let s = 1; s < n; s++) {
            const mid = node(px + ((x - px) * s) / n, pz + ((z - pz) * s) / n);
            link(prev, mid);
            prev = mid;
          }
        }
        const cur = node(x, z);
        if (prev >= 0) link(prev, cur);
        prev = cur;
      }
    }

    // route only on the largest connected piece, so every pair of points has a path
    const n = this.xs.length;
    const comp = new Int32Array(n).fill(-1);
    let best = -1, bestSize = 0;
    for (let s = 0, c = 0; s < n; s++) {
      if (comp[s] >= 0) continue;
      let size = 0;
      const stack = [s];
      comp[s] = c;
      while (stack.length) {
        const u = stack.pop()!;
        size++;
        for (const v of this.adj[u]) if (comp[v] < 0) { comp[v] = c; stack.push(v); }
      }
      if (size > bestSize) { bestSize = size; best = c; }
      c++;
    }
    for (let i = 0; i < n; i++) {
      if (comp[i] !== best) continue;
      const k = this.cell(this.xs[i], this.zs[i]);
      const list = this.grid.get(k);
      if (list) list.push(i); else this.grid.set(k, [i]);
    }
    this.g = new Float64Array(n);
    this.from = new Int32Array(n);
    this.stamp = new Int32Array(n);
  }

  get size() { return this.xs.length; }
  private cell(x: number, z: number) { return (Math.floor(x / GRID) + 2000) * 4096 + Math.floor(z / GRID) + 2000; }

  /** Nearest routable road vertex, or -1 if the graph is empty. */
  nearest([x, z]: XZ): number {
    const cx = Math.floor(x / GRID), cz = Math.floor(z / GRID);
    let best = -1, bd = Infinity;
    for (let r = 0; r < 60; r++) {
      for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const list = this.grid.get((cx + dx + 2000) * 4096 + cz + dz + 2000);
        if (!list) continue;
        for (const i of list) {
          const d = (this.xs[i] - x) ** 2 + (this.zs[i] - z) ** 2;
          if (d < bd) { bd = d; best = i; }
        }
      }
      if (best >= 0 && Math.sqrt(bd) <= r * GRID) break;
    }
    return best;
  }

  at(i: number): XZ { return [this.xs[i], this.zs[i]]; }

  /** a → nearest road → shortest road path → nearest road → b. Falls back to a straight line. */
  path(a: XZ, b: XZ): XZ[] {
    const s = this.nearest(a), t = this.nearest(b);
    if (s < 0 || t < 0) return [a, b];
    const key = s * 1_000_003 + t;
    let mid = this.cache.get(key);
    if (!mid) {
      mid = this.astar(s, t);
      this.cache.set(key, mid);
    }
    return mid.length ? [a, ...mid, b] : [a, b];
  }

  private astar(s: number, t: number): XZ[] {
    const { xs, zs, g, from, stamp } = this;
    const run = ++this.run;
    const tx = xs[t], tz = zs[t];
    // binary heap of [priority, node]
    const hp: number[] = [], hn: number[] = [];
    const push = (p: number, v: number) => {
      let i = hp.length;
      hp.push(p); hn.push(v);
      while (i > 0) {
        const up = (i - 1) >> 1;
        if (hp[up] <= p) break;
        hp[i] = hp[up]; hn[i] = hn[up]; i = up;
      }
      hp[i] = p; hn[i] = v;
    };
    const pop = () => {
      const top = hn[0], p = hp.pop()!, v = hn.pop()!;
      const n = hp.length;
      if (n) {
        let i = 0;
        for (;;) {
          let c = 2 * i + 1;
          if (c >= n) break;
          if (c + 1 < n && hp[c + 1] < hp[c]) c++;
          if (hp[c] >= p) break;
          hp[i] = hp[c]; hn[i] = hn[c]; i = c;
        }
        hp[i] = p; hn[i] = v;
      }
      return top;
    };
    stamp[s] = run; g[s] = 0; from[s] = -1;
    push(Math.hypot(xs[s] - tx, zs[s] - tz), s);
    while (hp.length) {
      const u = pop();
      if (u === t) break;
      const nb = this.adj[u], w = this.len[u];
      for (let k = 0; k < nb.length; k++) {
        const v = nb[k], d = g[u] + w[k];
        if (stamp[v] === run && g[v] <= d) continue;
        stamp[v] = run; g[v] = d; from[v] = u;
        push(d + Math.hypot(xs[v] - tx, zs[v] - tz), v);
      }
    }
    if (stamp[t] !== run) return [];
    const out: XZ[] = [];
    for (let u = t; u >= 0; u = from[u]) out.push([xs[u], zs[u]]);
    return out.reverse();
  }
}
