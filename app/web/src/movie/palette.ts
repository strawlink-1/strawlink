import { Color } from "three";
import type { FieldPhase } from "./model";

/** Real-world colours of a Punjab paddy landscape in late October. */
export const LAND = {
  paddyGreen: new Color("#7d9b33"),
  paddyGold: new Color("#cda53c"),
  stubble: new Color("#c8a564"),
  windrow: new Color("#ead291"),
  shortStubble: new Color("#b59d6c"),
  soil: new Color("#6b5137"),
  soilDark: new Color("#4f3a27"),
  sprout: new Color("#7fb23e"),
  tilled: new Color("#8c6b45"),
  wet: new Color("#7a6446"),
  ember: new Color("#ff5a2c"),
  bale: new Color("#e8c66a"),
  highlight: new Color("#fff3c4"),
  select: new Color("#ffffff"),
  flash: new Color("#5fe0ff"),
};

export type FieldLook = { pre: Color; preRow: Color; post: Color; postRow: Color; wet: number; risk: number };

const c = (x: Color) => x.clone();

export function lookFor(phase: FieldPhase, progress: number, method?: "bale" | "seed"): FieldLook {
  const stubbleLook = { pre: c(LAND.stubble), preRow: c(LAND.windrow) };
  switch (phase) {
    case "standing":
      return { pre: c(LAND.paddyGreen).lerp(LAND.paddyGold, progress * 0.7), preRow: c(LAND.paddyGreen).multiplyScalar(0.82), post: c(LAND.paddyGreen), postRow: c(LAND.paddyGreen), wet: 0, risk: 0 };
    case "ripe":
      return { pre: c(LAND.paddyGold), preRow: c(LAND.paddyGold).multiplyScalar(0.85), post: c(LAND.paddyGold), postRow: c(LAND.paddyGold), wet: 0, risk: 0 };
    case "stubble":
      return { ...stubbleLook, post: c(LAND.stubble), postRow: c(LAND.windrow), wet: 0, risk: 0 };
    case "working":
      return method === "seed"
        ? { ...stubbleLook, post: c(LAND.soilDark), postRow: c(LAND.sprout).multiplyScalar(0.75), wet: 0, risk: 0 }
        : { ...stubbleLook, post: c(LAND.shortStubble), postRow: c(LAND.shortStubble).multiplyScalar(0.9), wet: 0, risk: 0 };
    case "baled":
      return { pre: c(LAND.shortStubble), preRow: c(LAND.shortStubble).multiplyScalar(0.9), post: c(LAND.shortStubble), postRow: c(LAND.shortStubble), wet: 0, risk: 0 };
    case "seeded":
      return { pre: c(LAND.soilDark), preRow: c(LAND.sprout), post: c(LAND.soilDark), postRow: c(LAND.sprout), wet: 0, risk: 0 };
    case "cleared":
      return { pre: c(LAND.tilled), preRow: c(LAND.soil), post: c(LAND.tilled), postRow: c(LAND.soil), wet: 0, risk: 0 };
    case "wet":
      return { pre: c(LAND.wet), preRow: c(LAND.stubble).multiplyScalar(0.6), post: c(LAND.wet), postRow: c(LAND.wet), wet: 1, risk: 0 };
    case "risk":
      return { ...stubbleLook, post: c(LAND.stubble), postRow: c(LAND.windrow), wet: 0, risk: 1 };
  }
}

/** HUD colours for statuses (match the 3D look so the legend reads true). */
export const PHASE_UI: Record<FieldPhase, { label: string; color: string }> = {
  standing: { label: "Paddy standing", color: "#8fa83a" },
  ripe: { label: "Ripe, harvest due", color: "#cda53c" },
  stubble: { label: "Harvested, straw on field", color: "#d9b76c" },
  working: { label: "Machine working", color: "#ffd84d" },
  baled: { label: "Baled, awaiting truck", color: "#e8c66a" },
  seeded: { label: "Wheat sown in straw", color: "#7fb23e" },
  cleared: { label: "Cleared", color: "#8c6b45" },
  wet: { label: "Too wet after rain", color: "#5b8fd6" },
  risk: { label: "At risk of missing deadline", color: "#ff5a2c" },
};
