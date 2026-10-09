import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { PASSES, progress, sweep, type Work } from "../sim/dayplan";
import type { Cell } from "../sim/geo";
import { useStage, type Look } from "../sim/stage";
import { Label } from "./Label";
import { useWorld } from "../sim/world";
import { LOOK_COLOR, LOOK_HALO, LOOKS, textures } from "./looks";

const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const WHITE = new THREE.Color("#ffffff");
const INK = new THREE.Color("#111827");
const BALE = new THREE.Color("#f6cf4a");
const clamp01 = (u: number) => Math.min(1, Math.max(0, u));
const ease = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
const MAX_STRIPS = 32, MAX_BALES = 120;
const BALE_SPOTS = [[-0.22, -0.18], [0.2, 0.05], [-0.05, 0.26]];

/**
 * Every field in the block. One draw call per ground texture; each field's colour, height and
 * outline glow ease towards what the current view (and, when the day is playing, the plan) says.
 */
export function Fields({ reduced }: { reduced: boolean }) {
  const { cells, day, clock, selected, select, geo } = useWorld();
  const mode = useStage();
  const live = useRef({ mode, day, selected, cells });
  live.current = { mode, day, selected, cells };

  const tex = useMemo(textures, []);
  const box = useMemo(() => new THREE.BoxGeometry(1, 1, 1), []);
  const flat = useMemo(() => new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), []);
  const mats = useMemo(() => [tex.rows, tex.soil, tex.hatch].map((map) => {
    const top = new THREE.MeshLambertMaterial({ map });
    const side = new THREE.MeshLambertMaterial({ color: "#7d7d7d" }); // × the field's colour = a darker edge
    return [side, side, top, side, side, side];
  }), [tex]);
  const haloMat = useMemo(() => new THREE.MeshBasicMaterial({ map: tex.halo, transparent: true, depthWrite: false, toneMapped: false }), [tex]);
  const baleMat = useMemo(() => new THREE.MeshLambertMaterial({ color: "#ffffff" }), []);

  const meshes = useRef<(THREE.InstancedMesh | null)[]>([null, null, null]);
  const halo = useRef<THREE.InstancedMesh>(null);
  const strips = useRef<THREE.InstancedMesh>(null);
  const bales = useRef<THREE.InstancedMesh>(null);
  const N = cells.length;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const state = useMemo(() => cells.map(() => ({ h: 0.02, c: new THREE.Color("#e2ead7"), tex: -1, halo: false })), [N]);
  const born = useRef<number | null>(null);
  const used = useRef({ strips: 0, bales: 0 });
  const hovered = useRef(-1);
  const [hover, setHover] = useState<Cell | null>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const tint = useMemo(() => new THREE.Color(), []);
  const sw = useMemo(() => ({ x: 0, z: 0, dir: 1, pass: 0, along: 0 }), []);
  useEffect(() => () => { document.body.style.cursor = ""; }, []);
  // three starts every instance as a unit box at the origin; hide them all until the first frame places them
  useLayoutEffect(() => {
    for (const m of [...meshes.current, halo.current, strips.current, bales.current]) {
      if (!m) continue;
      for (let i = 0; i < m.count; i++) m.setMatrixAt(i, ZERO);
      m.instanceMatrix.needsUpdate = true;
    }
    for (const st of state) { st.tex = -1; st.halo = false; }
    used.current = { strips: 0, bales: 0 };
  }, [N, state]);

  useFrame((s, dt) => {
    const { mode, day, selected, cells } = live.current;
    const [m0, m1, m2] = meshes.current;
    if (!m0 || !m1 || !m2 || !halo.current || !strips.current || !bales.current || !geo) return;
    const all = [m0, m1, m2];
    born.current ??= s.clock.elapsedTime;
    const age = s.clock.elapsedTime - born.current;
    const t = clock.current.t;
    const k = reduced ? 1 : 1 - Math.exp(-Math.min(dt, 0.1) * 6);
    const running = mode.live && day;
    let nStrip = 0, nBale = 0;

    for (let i = 0; i < cells.length && i < state.length; i++) {
      const c = cells[i], st = state[i];
      let look: Look = mode.look(c);
      let w: Work | undefined;
      let pr = 0;
      if (running && c.props.status !== "cleared") {
        w = day.service.get(c.id);
        if (w) {
          pr = progress(w, t);
          look = pr >= 1 ? (w.method === "seed" ? "seeded" : "soil") : "sched";
        }
      }
      if (mode.keep && !mode.keep.has(c.id)) look = "dim";
      const L = LOOKS[look];

      // fields rise out of the board when the scene opens, nearest first
      const rise = reduced ? 1 : ease(clamp01((age - 0.5 - (Math.hypot(c.x, c.z) / geo.span) * 1.6) / 0.8));
      st.h += (Math.max(0.02, L.h * rise) - st.h) * k;
      st.c.lerp(LOOK_COLOR[look], k);
      const lit = i === hovered.current || c.id === selected;
      tint.copy(st.c);
      if (lit) tint.lerp(WHITE, 0.28);

      if (st.tex !== L.tex) {
        if (st.tex >= 0) all[st.tex].setMatrixAt(i, ZERO);
        st.tex = L.tex;
      }
      dummy.position.set(c.x, st.h / 2, c.z);
      dummy.scale.set(c.w * 0.94, st.h, c.d * 0.94);
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      all[L.tex].setMatrixAt(i, dummy.matrix);
      all[L.tex].setColorAt(i, tint);

      // glowing outline: machine coming, at risk, or the field the user picked
      const glow = c.id === selected || c.id === mode.pin ? INK : LOOK_HALO[look];
      if (glow) {
        const grow = glow === INK ? 2.15 : 2;
        dummy.position.set(c.x, 0.03, c.z);
        dummy.scale.set(c.w * grow, 1, c.d * grow);
        dummy.updateMatrix();
        halo.current.setMatrixAt(i, dummy.matrix);
        halo.current.setColorAt(i, glow);
        st.halo = true;
      } else if (st.halo) {
        halo.current.setMatrixAt(i, ZERO);
        st.halo = false;
      }

      if (w && pr > 0 && pr < 1 && nStrip + 2 <= MAX_STRIPS) {
        // the cleared strip grows behind the machine, pass by pass
        sweep(c, pr, sw);
        const fw = c.w * 0.94, fd = c.d * 0.94, pw = fw / PASSES;
        const done = LOOK_COLOR[w.method === "seed" ? "seeded" : "soil"];
        if (sw.pass > 0) {
          dummy.position.set(c.x - fw / 2 + (sw.pass * pw) / 2, st.h + 0.006, c.z);
          dummy.scale.set(sw.pass * pw, 0.012, fd);
          dummy.updateMatrix();
          strips.current.setMatrixAt(nStrip, dummy.matrix);
          strips.current.setColorAt(nStrip++, done);
        }
        const len = Math.max(0.001, sw.along * fd);
        dummy.position.set(c.x - fw / 2 + (sw.pass + 0.5) * pw, st.h + 0.006, sw.dir < 0 ? c.z + fd / 2 - len / 2 : c.z - fd / 2 + len / 2);
        dummy.scale.set(pw, 0.012, len);
        dummy.updateMatrix();
        strips.current.setMatrixAt(nStrip, dummy.matrix);
        strips.current.setColorAt(nStrip++, done);
      }

      if (w && pr >= 1 && w.method === "bale") {
        // bales wait on the field until the truck in the plan collects them
        const pick = day!.pickup.get(c.id);
        if ((pick === undefined || t < pick) && nBale + 3 <= MAX_BALES) {
          for (const [bx, bz] of BALE_SPOTS) {
            dummy.position.set(c.x + bx * c.w, st.h + 0.09, c.z + bz * c.d);
            dummy.scale.set(0.2, 0.18, 0.28);
            dummy.updateMatrix();
            bales.current.setMatrixAt(nBale, dummy.matrix);
            bales.current.setColorAt(nBale++, BALE);
          }
        }
      }
    }
    for (let i = nStrip; i < used.current.strips; i++) strips.current.setMatrixAt(i, ZERO);
    for (let i = nBale; i < used.current.bales; i++) bales.current.setMatrixAt(i, ZERO);
    used.current.strips = nStrip;
    used.current.bales = nBale;
    for (const m of [...all, halo.current, strips.current, bales.current]) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      m.boundingSphere = null; // heights and membership change; keep picking exact
    }
  });

  const move = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    const i = e.instanceId ?? -1;
    if (i !== hovered.current) {
      hovered.current = i;
      setHover(i >= 0 ? cells[i] ?? null : null);
      document.body.style.cursor = i >= 0 ? "pointer" : "";
    }
  };
  const out = () => { hovered.current = -1; setHover(null); document.body.style.cursor = ""; };
  const pick = (e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    if (e.instanceId !== undefined && cells[e.instanceId]) select(cells[e.instanceId].id);
  };

  if (!N) return null;
  return (
    <group>
      <group onPointerMove={move} onPointerOut={out} onClick={pick}>
        {mats.map((mat, i) => (
          <instancedMesh key={`${i}-${N}`} ref={(m) => { meshes.current[i] = m; }} args={[box, mat, N]} castShadow receiveShadow frustumCulled={false} />
        ))}
      </group>
      <instancedMesh key={`h-${N}`} ref={halo} args={[flat, haloMat, N]} frustumCulled={false} renderOrder={3} />
      <instancedMesh ref={strips} args={[box, mats[1], MAX_STRIPS]} frustumCulled={false} />
      <instancedMesh ref={bales} args={[box, baleMat, MAX_BALES]} castShadow frustumCulled={false} />
      {hover && hover.id !== selected && (
        <Label at={[hover.x, 1.6, hover.z]} above>
          <div className="tip3d"><b>Field {hover.id}</b> {hover.props.village_name} · {hover.props.straw_t.toFixed(1)} t of straw</div>
        </Label>
      )}
    </group>
  );
}
