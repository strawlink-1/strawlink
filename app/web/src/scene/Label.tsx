import { useFrame } from "@react-three/fiber";
import { useEffect, useId, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react";
import * as THREE from "three";

type Entry = { node: ReactNode; el: HTMLDivElement | null };
const entries = new Map<string, Entry>();
let snapshot: [string, Entry][] = [];
const subs = new Set<() => void>();
const publish = () => { snapshot = [...entries]; subs.forEach((f) => f()); };
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };

/**
 * A text label pinned to a point in the scene. The text is ordinary HTML drawn by <LabelLayer/>
 * over the map; this component only says where it goes and moves it each frame.
 */
export function Label({ at, shown = true, above = false, children }: { at: [number, number, number]; shown?: boolean; above?: boolean; children: ReactNode }) {
  const id = useId();
  const g = useRef<THREE.Group>(null!);
  const v = useMemo(() => new THREE.Vector3(), []);
  useEffect(() => {
    const e = entries.get(id);
    if (e) e.node = children; else entries.set(id, { node: children, el: null });
    publish();
  });
  useEffect(() => () => { entries.delete(id); publish(); }, [id]);
  useFrame((s) => {
    const el = entries.get(id)?.el;
    if (!el) return;
    g.current.getWorldPosition(v).project(s.camera);
    const on = shown && v.z < 1 && Math.abs(v.x) < 1.3 && Math.abs(v.y) < 1.3;
    if ((el.style.display === "block") !== on) el.style.display = on ? "block" : "";
    if (on) el.style.transform = `translate(${((v.x * 0.5 + 0.5) * s.size.width).toFixed(1)}px, ${((-v.y * 0.5 + 0.5) * s.size.height).toFixed(1)}px) translate(-50%, ${above ? "-100%" : "-50%"})`;
  });
  return <group ref={g} position={at} />;
}

/** Where the labels are drawn. Mounted once, over the canvas. */
export function LabelLayer() {
  const list = useSyncExternalStore(subscribe, () => snapshot);
  return <>{list.map(([id, e]) => <div key={id} className="pin3d" ref={(el) => { e.el = el; }}>{e.node}</div>)}</>;
}
