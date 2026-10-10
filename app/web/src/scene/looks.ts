import * as THREE from "three";
import { rng } from "../sim/geo";
import type { Look } from "../sim/stage";

/**
 * How each kind of field is drawn. Colours follow the land itself — green crop, gold straw,
 * brown cleared soil — so the map reads at a glance.
 *   tex 0 = crop rows, 1 = bare soil furrows, 2 = warning hatch
 */
export const LOOKS: Record<Look, { tex: 0 | 1 | 2; color: string; h: number; halo?: string; label: string; hint: string }> = {
  paddy: { tex: 0, color: "#6dbb5a", h: 0.28, label: "Crop still standing", hint: "Not harvested yet. The satellite forecast says when it will be." },
  ripe: { tex: 0, color: "#b9cf52", h: 0.28, label: "Harvest window open", hint: "Inside the forecast's harvest window." },
  straw: { tex: 0, color: "#f2b632", h: 0.13, label: "Straw waiting", hint: "Harvested. Straw is lying on the field and no machine is free for it today." },
  sched: { tex: 0, color: "#f2b632", h: 0.13, halo: "#1d4ed8", label: "Machine comes today", hint: "A baler or seeder visits this field in today's plan. Blue outline." },
  soil: { tex: 1, color: "#a67c52", h: 0.05, label: "Cleared", hint: "Straw baled and taken away, or wheat sown straight into it. Ready for the next crop." },
  seeded: { tex: 1, color: "#9b8a55", h: 0.05, label: "Cleared, wheat sown", hint: "A Super Seeder sowed wheat directly into the straw." },
  risk: { tex: 2, color: "#e5484d", h: 0.13, halo: "#e5484d", label: "At risk", hint: "No machine can reach it before the sowing deadline." },
  wet: { tex: 0, color: "#5aa7e8", h: 0.11, label: "Too wet", hint: "Rain is above the wet threshold; machines wait for it to dry." },
  burned: { tex: 1, color: "#3a302c", h: 0.04, halo: "#f97316", label: "Burned", hint: "A burn scar was detected in 2025 imagery." },
  dim: { tex: 0, color: "#d5ddcb", h: 0.03, label: "Other fields", hint: "Not part of what this page is showing." },
  bale: { tex: 0, color: "#f2b632", h: 0.13, label: "Baled for a plant", hint: "Route: bale the straw and truck it to a plant that has room this week." },
  seed: { tex: 0, color: "#8b5cf6", h: 0.13, label: "Wheat sown into straw", hint: "Route: a Super Seeder sows wheat directly, leaving the straw as mulch." },
};

export const LOOK_COLOR = Object.fromEntries(Object.entries(LOOKS).map(([k, v]) => [k, new THREE.Color(v.color)])) as Record<Look, THREE.Color>;
export const LOOK_HALO = Object.fromEntries(Object.entries(LOOKS).map(([k, v]) => [k, v.halo ? new THREE.Color(v.halo) : null])) as Record<Look, THREE.Color | null>;

function canvas(size: number, draw: (g: CanvasRenderingContext2D, s: number) => void) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  draw(c.getContext("2d")!, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Every field tile has a darker edge: that is the parcel outline. */
function edge(g: CanvasRenderingContext2D, s: number, weight = 6) {
  g.lineWidth = weight;
  g.strokeStyle = "rgba(0,0,0,0.3)";
  g.strokeRect(weight / 2, weight / 2, s - weight, s - weight);
}

function speckle(g: CanvasRenderingContext2D, s: number, seed: number, n: number) {
  const r = rng(seed);
  for (let i = 0; i < n; i++) {
    g.fillStyle = r() > 0.5 ? "rgba(255,255,255,0.2)" : "rgba(0,0,0,0.07)";
    g.fillRect(r() * s, r() * s, 2, 2);
  }
}

let cache: { rows: THREE.Texture; soil: THREE.Texture; hatch: THREE.Texture; halo: THREE.Texture } | null = null;

/** Near-white tiles; each field's colour is multiplied in per instance. */
export function textures() {
  if (cache) return cache;
  cache = {
    rows: canvas(128, (g, s) => {
      g.fillStyle = "#f6f6f6"; g.fillRect(0, 0, s, s);
      g.fillStyle = "rgba(0,0,0,0.11)";
      for (let y = 6; y < s; y += 12) g.fillRect(0, y, s, 5);
      speckle(g, s, 7, 200);
      edge(g, s);
    }),
    soil: canvas(128, (g, s) => {
      g.fillStyle = "#f0f0f0"; g.fillRect(0, 0, s, s);
      g.fillStyle = "rgba(0,0,0,0.1)";
      for (let y = 4; y < s; y += 8) g.fillRect(0, y, s, 2);
      speckle(g, s, 11, 320);
      edge(g, s);
    }),
    hatch: canvas(128, (g, s) => {
      g.fillStyle = "#f8f8f8"; g.fillRect(0, 0, s, s);
      g.strokeStyle = "rgba(0,0,0,0.22)"; g.lineWidth = 10;
      for (let x = -s; x < s * 2; x += 26) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x + s, s); g.stroke(); }
      edge(g, s, 8);
    }),
    // a crisp frame just outside the field, tinted per field
    halo: canvas(128, (g, s) => {
      g.clearRect(0, 0, s, s);
      g.strokeStyle = "#ffffff"; g.lineWidth = 9;
      g.strokeRect(27, 27, s - 54, s - 54);
    }),
  };
  return cache;
}
