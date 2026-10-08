import { useFrame, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { useClockSample } from "./clock";
import { hhmm } from "./geo";
import { livePoses } from "./Machines";
import { fieldPhaseAt, plantFillAt, poseAt, type World } from "./model";
import { PHASE_UI } from "./palette";

/** World-space anchors for DOM labels; resolved every frame by <LabelProjector/>. */
export const anchors = new Map<string, () => THREE.Vector3 | null>();
let overlay: HTMLDivElement | null = null;
export const setOverlay = (el: HTMLDivElement | null) => { overlay = el; };

const v = new THREE.Vector3();

/** Projects every [data-anchor] element in the overlay onto the screen (no React re-render). */
export function LabelProjector() {
  const { camera, size } = useThree();
  useFrame(() => {
    if (!overlay) return;
    const els = Array.from(overlay.querySelectorAll<HTMLElement>("[data-anchor]"));
    const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
    const items: { el: HTMLElement; x: number; y: number; d: number; fade: number; pinned: boolean }[] = [];
    els.forEach((el) => {
      const get = anchors.get(el.dataset.anchor!);
      const p = get?.();
      if (!p) { el.style.opacity = "0"; el.style.pointerEvents = "none"; return; }
      const d = camera.position.distanceTo(p);
      v.copy(p).project(camera);
      const behind = v.z > 1;
      const x = (v.x * 0.5 + 0.5) * size.width, y = (-v.y * 0.5 + 0.5) * size.height;
      const far = Number(el.dataset.far ?? 9000);
      const fade = behind ? 0 : Math.max(0, Math.min(1, (far - d) / (far * 0.35)));
      const pinned = !!el.dataset.pinned && !behind;
      items.push({ el, x, y, d, fade: pinned ? 1 : fade, pinned });
    });
    // pinned first, then nearest first; a label that would overlap one already placed is hidden
    items.sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.d - b.d);
    for (const it of items) {
      const w = it.el.offsetWidth, h = it.el.offsetHeight;
      const r = { x0: it.x - w / 2, y0: it.y - h, x1: it.x + w / 2, y1: it.y };
      const clash = !it.pinned && placed.some((p) => r.x0 < p.x1 && r.x1 > p.x0 && r.y0 < p.y1 && r.y1 > p.y0);
      const visible = it.fade > 0.02 && !clash;
      if (visible) placed.push(r);
      it.el.style.opacity = String(visible ? it.fade : 0);
      it.el.style.transform = `translate(${it.x.toFixed(1)}px, ${it.y.toFixed(1)}px) translate(-50%, -100%)`;
      it.el.style.zIndex = String(10000 - Math.round(it.d));
      it.el.style.pointerEvents = visible && it.fade > 0.3 ? "auto" : "none";
    }
  });
  return null;
}

const ACTIVITY: Record<string, string> = { idle: "parked", drive: "on the road", work: "working", load: "loading straw", unload: "unloading at plant" };

/** Label content (refreshed a few times a second). Positions are set by LabelProjector. */
export function Labels({
  world, hovered, hoveredMachine, selectedMachine, onPickMachine,
}: {
  world: World;
  hovered: string | null;
  hoveredMachine: string | null;
  selectedMachine: string | null;
  onPickMachine: (id: string) => void;
}) {
  const clock = useClockSample(5);
  const t = clock.t;

  for (const vg of world.villages) anchors.set(`v:${vg.id}`, () => new THREE.Vector3(vg.pos[0], 40, vg.pos[1]));
  for (const p of world.plants) anchors.set(`p:${p.id}`, () => new THREE.Vector3(p.pos[0], 60, p.pos[1]));
  for (const m of world.machines) anchors.set(`m:${m.id}`, () => {
    const lp = livePoses.get(m.id);
    return lp ? new THREE.Vector3(lp.pos.x, 5.5 * lp.scale, lp.pos.z) : null;
  });
  const hf = hovered ? world.fieldById.get(hovered) : null;
  if (hf) anchors.set("hover", () => new THREE.Vector3(hf.center[0], 6, hf.center[1]));

  return (
    <>
      {world.villages.map((vg) => (
        <div key={vg.id} className="lbl lbl-village" data-anchor={`v:${vg.id}`} data-far="14000">
          {vg.name}
        </div>
      ))}
      {world.plants.map((p) => {
        const fill = plantFillAt(p, t);
        const share = Math.min(1, fill / Math.max(1, p.depot));
        return (
          <div key={p.id} className="lbl lbl-plant" data-anchor={`p:${p.id}`} data-far="30000" title="Synthetic plant; depot fill = starting fill + tonnes delivered in this plan">
            <b>{p.name.replace(" (synthetic)", "")}</b>
            <span className="lbl-bar"><i style={{ width: `${share * 100}%`, background: share > 0.9 ? "#ff5a2c" : "#e8c66a" }} /></span>
            <small>{fill.toFixed(0)} / {p.depot} t depot</small>
          </div>
        );
      })}
      {world.machines.map((m) => {
        const pose = poseAt(m, t);
        const next = m.stops.find((s) => s.depart > t);
        const isSel = selectedMachine === m.id, isHov = hoveredMachine === m.id;
        if (m.stops.length === 0 && !isSel && !isHov) return null;
        const fieldId = pose.leg.kind === "work" || pose.leg.kind === "load" ? pose.leg.fieldId : undefined;
        return (
          <button
            key={m.id}
            className={`lbl lbl-machine${isSel ? " sel" : ""}`}
            data-anchor={`m:${m.id}`}
            data-far={pose.activity === "idle" && !isSel && !isHov ? "3500" : "16000"}
            data-pinned={isSel ? "1" : undefined}
            style={{ ["--mc" as string]: m.color }}
            onClick={() => onPickMachine(m.id)}
          >
            <i className="dot" />
            <b>{m.id}</b>
            <span>
              {ACTIVITY[pose.activity]}
              {fieldId ? ` · ${fieldId}` : ""}
              {pose.activity === "work" ? ` ${Math.round(pose.progress * 100)}%` : ""}
              {pose.activity !== "work" && next ? ` · next ${next.fieldId} ${hhmm(next.arrive)}` : ""}
            </span>
          </button>
        );
      })}
      {hf && (() => {
        const { phase, progress } = fieldPhaseAt(hf, t, world.date);
        return (
          <div className="lbl lbl-field" data-anchor="hover" data-pinned="1">
            <b>{hf.id}</b> · {hf.villageName}
            <span style={{ color: PHASE_UI[phase].color }}>
              {PHASE_UI[phase].label}{phase === "working" ? ` ${Math.round(progress * 100)}%` : ""}
            </span>
            <small>{hf.straw.toFixed(1)} t straw{hf.work ? ` · ${hf.work.machineId} ${hhmm(hf.work.t0)}–${hhmm(hf.work.t1)}` : world.unassigned.get(hf.id) ? ` · waiting: ${world.unassigned.get(hf.id)}` : ""}</small>
          </div>
        );
      })()}
    </>
  );
}
