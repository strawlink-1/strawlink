import { rng, type Box, type Cell, type XZ } from "../sim/geo";
import type { RoadLine } from "../sim/roads";

const P = {
  land: "#e7eedd", patches: ["#e2ead7", "#eaf0e1", "#dfe8d3", "#e5ecda"], bed: "#b7c2ab",
  casing: "#c3ccb7", road: "#ffffff", lane: "#f6f4ea", water: "#9fd0ee", built: "rgba(160,140,110,0.09)",
  photoTint: "rgba(255,255,255,0.05)",
};

/** Fine light-and-dark speckle, tiled over the photo: detail the imagery itself runs out of up close. */
function grain(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = 192;
  const g = c.getContext("2d")!, r = rng(7);
  for (let y = 0; y < c.height; y += 2) {
    for (let x = 0; x < c.width; x += 2) {
      const v = r();
      g.fillStyle = v < 0.5 ? `rgba(20,40,10,${(0.5 - v) * 0.22})` : `rgba(255,250,220,${(v - 0.5) * 0.16})`;
      g.fillRect(x, y, 2, 2);
    }
  }
  return c;
}

// drawn width in scene units (1 unit = 100 m): wider than life so the roads machines use read from far away
const ROAD: Record<string, { w: number; major: boolean }> = {
  primary: { w: 0.62, major: true }, secondary: { w: 0.58, major: true }, tertiary: { w: 0.52, major: true },
  unclassified: { w: 0.4, major: true }, track: { w: 0.2, major: false },
  residential: { w: 0.13, major: false }, service: { w: 0.11, major: false }, path: { w: 0.1, major: false }, footway: { w: 0.1, major: false },
};

export type GroundInput = {
  box: Box;
  cells: Cell[];
  roads: RoadLine[];
  water: RoadLine[];
  /** satellite mosaic and where it sits in scene units */
  photo?: { canvas: HTMLCanvasElement; x: number; z: number; w: number; d: number } | null;
};

/**
 * Paint the block as a calm map: pale farmland (or the satellite photo), the real waterways and
 * roads from OpenStreetMap with the through-roads clearly on top, and a bed under every field.
 */
export function paintGround(canvas: HTMLCanvasElement, input: GroundInput, maxPx = 4096) {
  const { box, cells, roads, water, photo } = input;
  const W = box.x1 - box.x0, D = box.z1 - box.z0;
  const k = maxPx / Math.max(W, D); // pixels per scene unit
  canvas.width = Math.round(W * k);
  canvas.height = Math.round(D * k);
  const g = canvas.getContext("2d")!;
  const X = (x: number) => (x - box.x0) * k, Z = (z: number) => (z - box.z0) * k;
  const trace = (pts: XZ[]) => {
    g.beginPath();
    pts.forEach(([x, z], i) => (i ? g.lineTo(X(x), Z(z)) : g.moveTo(X(x), Z(z))));
  };

  g.fillStyle = P.land;
  g.fillRect(0, 0, canvas.width, canvas.height);
  if (photo) {
    g.drawImage(photo.canvas, X(photo.x - photo.w / 2), Z(photo.z - photo.d / 2), photo.w * k, photo.d * k);
    g.fillStyle = P.photoTint;
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = g.createPattern(grain(), "repeat")!;
    g.fillRect(0, 0, canvas.width, canvas.height);
  } else {
    // a faint quilt of neighbouring farms that are not in the programme
    const r = rng(42);
    const step = 1.1;
    for (let z = box.z0; z < box.z1; z += step) {
      for (let x = box.x0; x < box.x1;) {
        const w = step * (1 + Math.floor(r() * 3));
        g.fillStyle = P.patches[Math.floor(r() * P.patches.length)];
        g.fillRect(X(x) + 1, Z(z) + 1, w * k - 2, step * k - 2);
        x += w;
      }
    }
    // built-up areas: wherever village streets are dense
    g.fillStyle = P.built;
    for (const line of roads) {
      if (line.kind !== "residential") continue;
      for (const [x, z] of line.pts) { g.beginPath(); g.arc(X(x), Z(z), 0.5 * k, 0, Math.PI * 2); g.fill(); }
    }
  }

  g.lineCap = "round";
  g.lineJoin = "round";
  g.strokeStyle = P.water;
  g.globalAlpha = photo ? 0.5 : 0.9;
  for (const line of water) { g.lineWidth = (line.kind === "canal" ? 0.45 : 0.2) * k; trace(line.pts); g.stroke(); }

  // village streets and farm tracks stay faint; the through-roads are drawn boldly on top
  g.globalAlpha = photo ? 0.35 : 0.75;
  g.strokeStyle = P.lane;
  for (const line of roads) {
    const spec = ROAD[line.kind] ?? ROAD.track;
    if (spec.major) continue;
    g.lineWidth = spec.w * k;
    trace(line.pts);
    g.stroke();
  }
  g.globalAlpha = photo ? 0.42 : 1;
  for (const pass of ["casing", "fill"] as const) {
    for (const line of roads) {
      const spec = ROAD[line.kind] ?? ROAD.track;
      if (!spec.major) continue;
      g.lineWidth = (spec.w + (pass === "casing" ? 0.14 : 0)) * k;
      g.strokeStyle = pass === "casing" ? P.casing : P.road;
      trace(line.pts);
      g.stroke();
    }
  }
  g.globalAlpha = 1;

  // a bed under every field, so each parcel has a crisp outline
  g.fillStyle = P.bed;
  for (const c of cells) g.fillRect(X(c.x - c.w / 2) - 2, Z(c.z - c.d / 2) - 2, c.w * k + 4, c.d * k + 4);

  // the block has no edge: its rim fades out, and the land around it shows through
  const rim = 1.6 * k;
  g.globalCompositeOperation = "destination-out";
  for (const [x, y, w, h, x1, y1, x2, y2] of [
    [0, 0, canvas.width, rim, 0, 0, 0, rim], [0, canvas.height - rim, canvas.width, rim, 0, canvas.height, 0, canvas.height - rim],
    [0, 0, rim, canvas.height, 0, 0, rim, 0], [canvas.width - rim, 0, rim, canvas.height, canvas.width, 0, canvas.width - rim, 0],
  ]) {
    const grad = g.createLinearGradient(x1, y1, x2, y2);
    grad.addColorStop(0, "rgba(0,0,0,1)");
    grad.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grad;
    g.fillRect(x, y, w, h);
  }
  g.globalCompositeOperation = "source-over";
}
