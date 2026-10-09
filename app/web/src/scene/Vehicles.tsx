import { Line } from "@react-three/drei";
import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, type MutableRefObject, type RefObject } from "react";
import * as THREE from "three";
import { machineName } from "../api";
import { at, loadAt, progress, sweep, working, type Track } from "../sim/dayplan";
import { useWorld, type Clock } from "../sim/world";

export const MACHINE_COLOR = { baler_set: "#1d4ed8", seeder: "#7c3aed", truck: "#f97316" } as const;
export const MACHINE_JOB = { baler_set: "bales the straw", seeder: "sows wheat into the straw", truck: "carries bales to a plant" } as const;

function Block({ p, s, c }: { p: [number, number, number]; s: [number, number, number]; c: string }) {
  return <mesh position={p} castShadow><boxGeometry args={s} /><meshLambertMaterial color={c} /></mesh>;
}

function Wheel({ x, z, r }: { x: number; z: number; r: number }) {
  return (
    <group position={[x, r, z]}>
      <mesh rotation={[0, 0, Math.PI / 2]} castShadow><cylinderGeometry args={[r, r, 0.22, 12]} /><meshLambertMaterial color="#1b2026" /></mesh>
      <mesh rotation={[0, 0, Math.PI / 2]}><cylinderGeometry args={[r * 0.45, r * 0.45, 0.24, 8]} /><meshLambertMaterial color="#e5e7eb" /></mesh>
    </group>
  );
}

/** Toy-block tractor with a driver; the implement behind it differs for baler and seeder. */
function Tractor({ color, tool }: { color: string; tool: "baler_set" | "seeder" }) {
  return (
    <>
      <Block p={[0, 0.55, 0.2]} s={[0.7, 0.4, 1.35]} c={color} />
      <Block p={[0, 0.9, 0.6]} s={[0.6, 0.34, 0.6]} c={color} />
      <Block p={[0.22, 1.3, 0.75]} s={[0.09, 0.5, 0.09]} c="#374151" />
      <Block p={[0, 1.02, -0.2]} s={[0.36, 0.42, 0.24]} c="#f8fafc" />
      <Block p={[0, 1.4, -0.2]} s={[0.3, 0.3, 0.3]} c="#f5c28a" />
      <Block p={[0, 1.78, -0.2]} s={[0.76, 0.07, 0.66]} c="#111827" />
      <Wheel x={0.44} z={-0.25} r={0.42} /><Wheel x={-0.44} z={-0.25} r={0.42} />
      <Wheel x={0.38} z={0.68} r={0.25} /><Wheel x={-0.38} z={0.68} r={0.25} />
      {tool === "baler_set" ? (
        <>
          <Block p={[0, 0.58, -1.3]} s={[0.84, 0.72, 0.95]} c="#dc2626" />
          <Block p={[0, 0.3, -2.05]} s={[0.5, 0.4, 0.5]} c="#f5cf4a" />
          <Wheel x={0.46} z={-1.3} r={0.2} /><Wheel x={-0.46} z={-1.3} r={0.2} />
        </>
      ) : (
        <>
          <Block p={[0, 0.36, -1.15]} s={[2.0, 0.26, 0.5]} c="#5b21b6" />
          <Block p={[0, 0.68, -1.15]} s={[1.6, 0.36, 0.36]} c="#a78bfa" />
        </>
      )}
    </>
  );
}

function Truck({ bales }: { bales: RefObject<THREE.Group | null> }) {
  return (
    <>
      <Block p={[0, 0.9, 1.0]} s={[0.84, 0.84, 0.72]} c="#f97316" />
      <Block p={[0, 1.05, 1.37]} s={[0.68, 0.36, 0.03]} c="#1e293b" />
      <Block p={[0, 0.42, -0.2]} s={[0.84, 0.2, 2.3]} c="#334155" />
      <Block p={[0, 0.6, -0.5]} s={[0.92, 0.16, 1.8]} c="#94a3b8" />
      <Wheel x={0.44} z={0.9} r={0.27} /><Wheel x={-0.44} z={0.9} r={0.27} />
      <Wheel x={0.44} z={-0.4} r={0.27} /><Wheel x={-0.44} z={-0.4} r={0.27} />
      <Wheel x={0.44} z={-1.05} r={0.27} /><Wheel x={-0.44} z={-1.05} r={0.27} />
      <group ref={bales}>
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
          <mesh key={i} position={[i % 2 ? 0.21 : -0.21, 0.86 + (i > 3 ? 0.34 : 0), 0.05 - ((i >> 1) % 2) * 0.6 - (i > 3 ? 0.3 : 0)]} castShadow visible={false}>
            <boxGeometry args={[0.38, 0.32, 0.56]} /><meshLambertMaterial color="#f5cf4a" />
          </mesh>
        ))}
      </group>
    </>
  );
}

/** What a machine is doing at time t, in words. Shared by the map tags and the machine list. */
export function describe(track: Track, t: number, village?: (fieldId: string) => string | undefined): string {
  const w = working(track, t);
  if (w) {
    const v = village?.(w.field_id);
    return `${track.type === "seeder" ? "sowing wheat" : "baling straw"} ${v ? `in ${v}` : `on field ${w.field_id}`}`;
  }
  const first = track.keys[0].t, last = track.keys[track.keys.length - 1].t;
  if (t < first) return "waiting to start";
  if (track.type === "truck") {
    const on = loadAt(track, t);
    if (t >= last) return on > 0 ? "at the plant" : "finished for the day";
    return on > 0 ? `carrying ${on.toFixed(0)} t of bales to a plant` : "driving to collect bales";
  }
  return t >= last ? "finished for the day" : "driving to the next field";
}

/** A machine's name tag: where it wants to sit on the stage (px), and how far it has stepped up to clear another tag. */
type TagSlot = { el: HTMLSpanElement; x: number; y: number; w: number; to: number; off: number; shown: boolean };
const TAG_H = 25;

/** Places every tag once per frame, after the machines have moved: overlapping tags stack upwards. */
function TagLayout({ slots }: { slots: MutableRefObject<Map<string, TagSlot>> }) {
  const placed = useRef<TagSlot[]>([]);
  useFrame((_, dt) => {
    const list = placed.current;
    list.length = 0;
    const k = 1 - Math.exp(-Math.min(dt, 0.1) * 10);
    for (const a of slots.current.values()) {
      if (!a.shown) {
        if (a.el.style.display !== "none") a.el.style.display = "none";
        a.off = 0;
        continue;
      }
      if (a.el.style.display === "none") a.el.style.display = "";
      if (!a.w) a.w = a.el.offsetWidth || 90;
      let want = 0;
      for (let pass = 0; pass < 8; pass++) {
        let hit = false;
        for (const b of list) {
          if (Math.abs(a.x - b.x) < (a.w + b.w) / 2 + 4 && Math.abs(a.y - want - (b.y - b.to)) < TAG_H) {
            want = a.y - (b.y - b.to) + TAG_H;
            hit = true;
          }
        }
        if (!hit) break;
      }
      a.to = Math.min(want, TAG_H * 6);
      a.off += (a.to - a.off) * k;
      a.el.style.transform = `translate(${a.x.toFixed(1)}px, ${(a.y - a.off).toFixed(1)}px) translate(-50%, -100%)`;
      list.push(a);
    }
  });
  return null;
}

// toy-sized up close, icon-sized from far away, so machines are never lost on the map
const sizeAt = (far: number) => THREE.MathUtils.clamp(far / 44, 0.25, 2.6);
// machines that share a base park in a small ring around it instead of inside each other
const PARK = 1.5, TURN = 2.4;

/** A machine the plan gives no work today: it stays parked at its base. */
function Parked({ type, at, slot }: { type: Track["type"]; at: [number, number]; slot: number }) {
  const g = useRef<THREE.Group>(null!);
  const none = useRef<THREE.Group>(null);
  useFrame((s) => {
    const o = g.current;
    const size = sizeAt(s.camera.position.distanceTo(o.position));
    o.scale.setScalar(size);
    o.position.set(at[0] + Math.cos(slot * TURN) * PARK * size, 0, at[1] + Math.sin(slot * TURN) * PARK * size);
  });
  return (
    <group ref={g} position={[at[0], 0, at[1]]} rotation={[0, slot * 0.9, 0]}>
      {type === "truck" ? <Truck bales={none} /> : <Tractor color={MACHINE_COLOR[type]} tool={type} />}
    </group>
  );
}

function Vehicle({ track, clock, reduced, slots, bay, crowded }: { track: Track; clock: MutableRefObject<Clock>; reduced: boolean; slots: MutableRefObject<Map<string, TagSlot>>; bay: number; crowded: boolean }) {
  const { cellById, vehiclePos, follow, setFollow } = useWorld();
  const cells = useRef(cellById);
  cells.current = cellById;
  const g = useRef<THREE.Group>(null!);
  const body = useRef<THREE.Group>(null!);
  const bales = useRef<THREE.Group>(null);
  const tag = useRef<TagSlot | null>(null);
  const v3 = useMemo(() => new THREE.Vector3(), []);
  const p = useMemo(() => ({ x: 0, z: 0 }), []);
  const q = useMemo(() => ({ x: 0, z: 0 }), []);
  const sw = useMemo(() => ({ x: 0, z: 0, dir: 1, pass: 0, along: 0 }), []);
  const placed = useRef(false);
  const maxLoad = useMemo(() => Math.max(1, ...track.load.map(([, v]) => v)), [track]);
  const lastText = useRef("");
  const name = machineName(track.id);
  const followed = follow === track.id;
  useEffect(() => () => { vehiclePos.current.delete(track.id); }, [track.id, vehiclePos]);
  useEffect(() => {
    const layer = document.getElementById("tags");
    if (!layer) return;
    const el = document.createElement("span");
    el.title = `${name} ${MACHINE_JOB[track.type]} (synthetic fleet)`;
    el.style.display = "none";
    layer.appendChild(el);
    const slot: TagSlot = { el, x: 0, y: 0, w: 0, to: 0, off: 0, shown: false };
    slots.current.set(track.id, slot);
    tag.current = slot;
    lastText.current = "";
    const all = slots.current;
    return () => { el.remove(); all.delete(track.id); tag.current = null; };
  }, [name, track.id, track.type, slots]);
  const village = (id: string) => cells.current.get(id)?.props.village_name;

  useFrame((s, dt) => {
    const t = clock.current.t;
    const o = g.current;
    const w = working(track, t);
    const cell = w ? cells.current.get(w.field_id) : undefined;
    let yaw: number | null = null;
    if (w && cell) {
      // working: drive the field in passes, exactly where the cleared strip is growing
      sweep(cell, progress(w, t), sw);
      p.x = sw.x; p.z = sw.z;
      yaw = sw.dir < 0 ? Math.PI : 0;
    } else {
      at(track, t, p);
      at(track, t + 0.2, q);
      const dx = q.x - p.x, dz = q.z - p.z;
      if (dx * dx + dz * dz > 1e-8) yaw = Math.atan2(dx, dz);
    }
    // parked before its first job or after its last
    const idle = t < track.keys[0].t || t >= track.keys[track.keys.length - 1].t;
    const size = sizeAt(s.camera.position.distanceTo(o.position));
    if (idle) { p.x += Math.cos(bay * TURN) * PARK * size; p.z += Math.sin(bay * TURN) * PARK * size; }
    const k = reduced || !placed.current ? 1 : 1 - Math.exp(-Math.min(dt, 0.1) * 12);
    placed.current = true;
    o.position.x += (p.x - o.position.x) * k;
    o.position.z += (p.z - o.position.z) * k;
    if (yaw !== null) {
      let d = yaw - o.rotation.y;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      o.rotation.y += d * (reduced ? 1 : 1 - Math.exp(-Math.min(dt, 0.1) * 6));
    }
    vehiclePos.current.set(track.id, { x: o.position.x, z: o.position.z });

    const far = s.camera.position.distanceTo(o.position);
    body.current.scale.setScalar(size);

    if (bales.current) {
      const n = Math.round((loadAt(track, t) / maxLoad) * bales.current.children.length);
      bales.current.children.forEach((b, i) => (b.visible = i < n));
    }
    const slot = tag.current;
    if (slot) {
      // the name from far away; what it is doing once you are close or following it
      const near = far < 70 || followed;
      const mini = crowded && !near;
      const text = near ? `${name} · ${describe(track, t, village)}` : mini ? name.replace(/\D+/g, "") : name;
      if (text !== lastText.current) { slot.el.textContent = text; lastText.current = text; slot.w = 0; }
      const cls = `tag3d ${track.type}${followed ? " on" : ""}${mini ? " mini" : ""}`;
      if (slot.el.className !== cls) slot.el.className = cls;
      // project the point just above the machine to stage pixels; TagLayout does the placing
      v3.set(o.position.x, 2.1 * size + 0.4, o.position.z).project(s.camera);
      slot.shown = (!idle || followed) && v3.z < 1 && Math.abs(v3.x) < 1.05 && Math.abs(v3.y) < 1.05;
      slot.x = (v3.x * 0.5 + 0.5) * s.size.width;
      slot.y = (-v3.y * 0.5 + 0.5) * s.size.height;
    }
  });

  return (
    <group ref={g}>
      <group
        ref={body}
        onClick={(e) => { e.stopPropagation(); setFollow(followed ? null : track.id); }}
        onPointerOver={() => { document.body.style.cursor = "pointer"; }}
        onPointerOut={() => { document.body.style.cursor = ""; }}
      >
        {track.type === "truck" ? <Truck bales={bales} /> : <Tractor color={MACHINE_COLOR[track.type]} tool={track.type} />}
      </group>
    </group>
  );
}

/** The route a machine drives today, along the roads. The part already driven is drawn solid. */
function Route({ track, clock, strong }: { track: Track; clock: MutableRefObject<Clock>; strong: boolean }) {
  const pts = useMemo(() => track.path.map(([x, z]) => new THREE.Vector3(x, 0.15, z)), [track.path]);
  const color = track.type === "truck" ? "#f97316" : MACHINE_COLOR[track.type];
  // the trail behind the machine: every key the clock has passed
  const trail = useRef<{ geometry: { setPositions: (a: number[]) => void; instanceCount: number } }>(null);
  const keys = track.keys;
  const flat = useMemo(() => keys.flatMap((k) => [k.x, 0.17, k.z]), [keys]);
  const shown = useRef(-1);
  useFrame(() => {
    const t = clock.current.t;
    let n = 0;
    while (n < keys.length && keys[n].t <= t) n++;
    if (n === shown.current || !trail.current) return;
    shown.current = n;
    trail.current.geometry.instanceCount = Math.max(0, n - 1);
  });
  if (pts.length < 2) return null;
  return (
    <>
      <Line points={pts} color={color} lineWidth={strong ? 2.6 : 1.4} transparent opacity={strong ? 0.5 : 0.28} dashed dashSize={0.5} gapSize={0.4} />
      <Line ref={trail as never} points={flat as never} color={color} lineWidth={strong ? 4 : 2.6} transparent opacity={0.95} />
    </>
  );
}

export function Vehicles({ reduced }: { reduced: boolean }) {
  const { day, clock, follow, fleet } = useWorld();
  const slots = useRef(new Map<string, TagSlot>());
  if (!day) return null;
  const slotOf = new Map(fleet.map((m) => [m.id, m.slot]));
  return (
    <>
      {day.tracks.map((t) => <Route key={`r-${day.planId}-${t.id}`} track={t} clock={clock} strong={follow === t.id} />)}
      {day.tracks.map((t) => <Vehicle key={`${day.planId}-${t.id}`} track={t} clock={clock} reduced={reduced} slots={slots} bay={slotOf.get(t.id) ?? 0} crowded={day.tracks.length > 10} />)}
      {fleet.filter((m) => !m.works).map((m) => <Parked key={m.id} type={m.type} at={m.at} slot={m.slot} />)}
      <TagLayout slots={slots} />
    </>
  );
}
