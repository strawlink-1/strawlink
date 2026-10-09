import { useFrame, useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { deliveredBy } from "../sim/dayplan";
import { rng, type XZ } from "../sim/geo";
import { useStage } from "../sim/stage";
import { Label } from "./Label";
import { useWorld, type PlantView } from "../sim/world";
import { usePrefs } from "../ui/prefs";
import { paintGround } from "./ground";
import { useSatellite } from "./satellite";

/** The colour distant land fades into, and the sky behind it. */
export const HAZE = "#dfe8e4";
const LAND = "#e7eedd", LAND_PHOTO = "#8fa06f";

/** The land all around the block, out to the haze, so the map fills the view and has no edge. */
function Surround() {
  const { geo, select } = useWorld();
  const prefs = usePrefs();
  const wide = useMemo(() => {
    if (!geo) return null;
    const [w, s, e, n] = geo.bbox, dx = (e - w) * 1.7, dy = (n - s) * 1.7;
    return [w - dx, s - dy, e + dx, n + dy] as [number, number, number, number];
  }, [geo]);
  const photo = useSatellite(prefs.satellite && geo ? geo.project : null, prefs.satellite ? wide : null, { maxTiles: 200, fade: true });
  const tex = useMemo(() => {
    if (!photo) return null;
    const t = new THREE.CanvasTexture(photo.canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photo?.canvas]);
  useEffect(() => { if (tex) tex.needsUpdate = true; }, [tex, photo?.version]);
  if (!geo) return null;
  const far = geo.span * 16;
  return (
    <group onClick={() => select(null)}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.08, 0]}>
        <planeGeometry args={[far, far]} /><meshBasicMaterial color={prefs.satellite ? LAND_PHOTO : LAND} toneMapped={false} />
      </mesh>
      {prefs.satellite && photo && tex && (
        <mesh rotation={[-Math.PI / 2, 0, 0]} position={[photo.x, -0.04, photo.z]}>
          <planeGeometry args={[photo.w, photo.d]} /><meshBasicMaterial map={tex} transparent toneMapped={false} />
        </mesh>
      )}
    </group>
  );
}

/** The block itself: its land in full detail, with the real roads, waterways and a bed under every field. */
export function Ground() {
  const { geo, cells, roads, water, select } = useWorld();
  const prefs = usePrefs();
  const { gl } = useThree();
  const photo = useSatellite(prefs.satellite && geo ? geo.project : null, prefs.satellite && geo ? geo.bbox : null);
  const canvas = useMemo(() => document.createElement("canvas"), []);
  const map = useMemo(() => {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  }, [canvas]);

  useEffect(() => {
    if (!geo || !cells.length) return;
    paintGround(canvas, { box: geo.box, cells, roads, water, photo: prefs.satellite ? photo : null },
      Math.min(4096, gl.capabilities.maxTextureSize));
    map.needsUpdate = true;
    // fields never move; repaint only when the land or the photo changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geo, cells.length, roads, water, prefs.satellite, photo?.version]);

  const mat = useMemo(() => new THREE.MeshBasicMaterial({ map, toneMapped: false, transparent: true }), [map]);

  if (!geo) return null;
  const { box } = geo;
  const W = box.x1 - box.x0, D = box.z1 - box.z0, cx = (box.x0 + box.x1) / 2, cz = (box.z0 + box.z1) / 2;
  return (
    <group>
      <Surround />
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[cx, 0, cz]} material={mat} onClick={() => select(null)}>
        <planeGeometry args={[W, D]} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[cx, 0.012, cz]} receiveShadow renderOrder={1}>
        <planeGeometry args={[W, D]} /><shadowMaterial transparent opacity={0.18} depthWrite={false} />
      </mesh>
    </group>
  );
}

/** Houses along the real village streets, and trees along the lanes. Deterministic, so it looks the same every time. */
export function Settlements() {
  const { roads, villages, cells, geo } = useWorld();
  const houses = useRef<THREE.InstancedMesh>(null);
  const roofs = useRef<THREE.InstancedMesh>(null);
  const trunks = useRef<THREE.InstancedMesh>(null);
  const crowns = useRef<THREE.InstancedMesh>(null);

  const plan = useMemo(() => {
    const r = rng(2026);
    const inField = (x: number, z: number, pad: number) =>
      cells.some((c) => Math.abs(x - c.x) < c.w / 2 + pad && Math.abs(z - c.z) < c.d / 2 + pad);
    const house: { x: number; z: number; s: number; rot: number; tone: number }[] = [];
    const tree: { x: number; z: number; s: number }[] = [];
    for (const line of roads) {
      for (let i = 1; i < line.pts.length; i++) {
        const [ax, az] = line.pts[i - 1], [bx, bz] = line.pts[i];
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 0.05) continue;
        const nx = -(bz - az) / len, nz = (bx - ax) / len;
        if (line.kind === "residential") {
          // a house every ~70 m on alternating sides of the street
          for (let d = r() * 1.2; d < len && house.length < 380; d += 1.0 + r() * 0.9) {
            const side = r() > 0.5 ? 1 : -1, off = 0.3 + r() * 0.15;
            const x = ax + ((bx - ax) * d) / len + nx * off * side, z = az + ((bz - az) * d) / len + nz * off * side;
            if (!inField(x, z, 0.2)) house.push({ x, z, s: 0.26 + r() * 0.2, rot: Math.atan2(bx - ax, bz - az), tone: r() });
          }
        } else if (line.kind === "track" || line.kind === "unclassified" || line.kind === "tertiary") {
          for (let d = r() * 5; d < len && tree.length < 260; d += 3.5 + r() * 6) {
            const side = r() > 0.5 ? 1 : -1, off = 0.42 + r() * 0.25;
            const x = ax + ((bx - ax) * d) / len + nx * off * side, z = az + ((bz - az) * d) / len + nz * off * side;
            if (!inField(x, z, 0.25)) tree.push({ x, z, s: 0.45 + r() * 0.5 });
          }
        }
      }
    }
    // no street data: still mark each village with a small cluster
    if (!house.length) for (const v of villages) for (let i = 0; i < 26; i++) {
      const a = r() * Math.PI * 2, d = Math.sqrt(r()) * 2.4;
      house.push({ x: v.centre[0] + Math.cos(a) * d, z: v.centre[1] + Math.sin(a) * d, s: 0.3 + r() * 0.2, rot: r() * 3, tone: r() });
    }
    return { house, tree };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roads, villages.length, cells.length]);

  useLayoutEffect(() => {
    const o = new THREE.Object3D();
    const wall = new THREE.Color();
    plan.house.forEach((h, i) => {
      o.position.set(h.x, h.s * 0.45, h.z); o.rotation.set(0, h.rot, 0); o.scale.set(h.s, h.s * 0.9, h.s * 1.25); o.updateMatrix();
      houses.current?.setMatrixAt(i, o.matrix);
      houses.current?.setColorAt(i, wall.set(h.tone > 0.66 ? "#f3ece0" : h.tone > 0.33 ? "#ebe1cf" : "#faf7f0"));
      o.position.set(h.x, h.s * 0.9 + h.s * 0.22, h.z); o.rotation.set(0, h.rot + Math.PI / 4, 0); o.scale.set(h.s * 0.82, h.s * 0.45, h.s * 0.82); o.updateMatrix();
      roofs.current?.setMatrixAt(i, o.matrix);
    });
    o.rotation.set(0, 0, 0);
    plan.tree.forEach((t, i) => {
      o.position.set(t.x, t.s * 0.25, t.z); o.scale.set(t.s * 0.16, t.s * 0.5, t.s * 0.16); o.updateMatrix();
      trunks.current?.setMatrixAt(i, o.matrix);
      o.position.set(t.x, t.s * 0.85, t.z); o.scale.set(t.s * 0.55, t.s * 0.9, t.s * 0.55); o.updateMatrix();
      crowns.current?.setMatrixAt(i, o.matrix);
    });
    for (const m of [houses, roofs, trunks, crowns]) {
      if (!m.current) continue;
      m.current.instanceMatrix.needsUpdate = true;
      if (m.current.instanceColor) m.current.instanceColor.needsUpdate = true;
    }
  }, [plan]);

  if (!geo) return null;
  const nh = Math.max(1, plan.house.length), nt = Math.max(1, plan.tree.length);
  return (
    <group>
      <instancedMesh key={`w${nh}`} ref={houses} args={[undefined, undefined, nh]} castShadow frustumCulled={false}>
        <boxGeometry args={[1, 1, 1]} /><meshLambertMaterial color="#ffffff" />
      </instancedMesh>
      <instancedMesh key={`r${nh}`} ref={roofs} args={[undefined, undefined, nh]} castShadow frustumCulled={false}>
        <coneGeometry args={[1, 1, 4]} /><meshLambertMaterial color="#cf8468" />
      </instancedMesh>
      <instancedMesh key={`t${nt}`} ref={trunks} args={[undefined, undefined, nt]} frustumCulled={false}>
        <cylinderGeometry args={[1, 1, 1, 6]} /><meshLambertMaterial color="#9a7a58" />
      </instancedMesh>
      <instancedMesh key={`c${nt}`} ref={crowns} args={[undefined, undefined, nt]} castShadow frustumCulled={false}>
        <coneGeometry args={[1, 1, 7]} /><meshLambertMaterial color="#6faf7a" />
      </instancedMesh>
    </group>
  );
}

function Block({ p, s, c }: { p: [number, number, number]; s: [number, number, number]; c: string }) {
  return <mesh position={p} castShadow><boxGeometry args={s} /><meshLambertMaterial color={c} /></mesh>;
}

/** A plant in its yard beyond the block (drawn closer than it is), joined to the road network by an approach road. */
function Plant({ plant }: { plant: PlantView }) {
  const { day, clock } = useWorld();
  const pile = useRef<THREE.Mesh>(null!);
  const bar = useRef<HTMLElement>(null);
  const num = useRef<HTMLElement>(null);
  const shown = useRef(-1);
  const dayRef = useRef(day);
  dayRef.current = day;
  const { live, plantLabels } = useStage();

  useFrame((_, dt) => {
    const tonnes = plant.fill + (live && dayRef.current ? deliveredBy(dayRef.current, plant.id, clock.current.t) : 0);
    const f = Math.min(1, tonnes / plant.capacity);
    // the straw stack beside the factory grows as trucks deliver
    pile.current.scale.y += (Math.max(0.05, f) - pile.current.scale.y) * (1 - Math.exp(-Math.min(dt, 0.1) * 4));
    pile.current.position.y = (pile.current.scale.y * 2.2) / 2 + 0.1;
    const r = Math.round(tonnes);
    if (r !== shown.current) {
      shown.current = r;
      if (num.current) num.current.textContent = `${r}/${plant.capacity} t`;
      if (bar.current) bar.current.style.width = `${f * 100}%`;
    }
  });

  const [ex, ez] = plant.exit, [px, pz] = plant.at;
  const len = Math.hypot(px - ex, pz - ez), yaw = Math.atan2(px - ex, pz - ez);
  return (
    <group>
      {/* causeway from the road network to the plant */}
      <mesh position={[(ex + px) / 2, 0.02, (ez + pz) / 2]} rotation={[0, yaw, 0]} receiveShadow>
        <boxGeometry args={[0.8, 0.05, len]} /><meshLambertMaterial color="#f1eee4" />
      </mesh>
      <group position={[px, 0, pz]}>
        <mesh position={[0, 0.04, 0]} receiveShadow><boxGeometry args={[9, 0.08, 7]} /><meshLambertMaterial color="#d8d4c6" /></mesh>
        <group scale={1.15} position={[-0.8, 0, 0]}>
          <Block p={[0, 1.1, 0]} s={[3.2, 2.2, 2.4]} c="#e7ecf0" />
          <Block p={[0, 2.3, 0]} s={[3.4, 0.2, 2.6]} c="#5b6b7a" />
          <Block p={[1.0, 3.2, -0.6]} s={[0.5, 1.8, 0.5]} c="#ef4444" />
          <Block p={[1.0, 4.15, -0.6]} s={[0.62, 0.14, 0.62]} c="#f8fafc" />
          <Block p={[0, 0.6, 1.21]} s={[0.9, 1.2, 0.04]} c="#475569" />
          <Block p={[-1.0, 1.4, 1.21]} s={[0.6, 0.5, 0.04]} c="#38bdf8" />
        </group>
        <mesh ref={pile} position={[2.9, 0.1, 0.4]} castShadow><boxGeometry args={[1.8, 2.2, 2.2]} /><meshLambertMaterial color="#f6cf4a" /></mesh>
        <Label at={[0, 4.6, 0]} shown={plantLabels} above>
          <div className="label3d plant">
            <b>{plant.name}</b>
            <span className="meter"><i ref={bar as never} /></span>
            <small><span ref={num as never} /> stored · {plant.realKm.toFixed(0)} km away</small>
          </div>
        </Label>
      </group>
    </group>
  );
}

export function Plants() {
  const { plants } = useWorld();
  return <>{plants.map((p) => <Plant key={p.id} plant={p} />)}</>;
}

export function VillageLabels() {
  const { villages } = useWorld();
  const show = useStage().villageLabels;
  if (!show) return null;
  return (
    <>
      {villages.map((v) => (
        <group key={v.id} position={[v.centre[0], 0, v.centre[1]]}>
          <mesh position={[0, 1.6, 0]}><cylinderGeometry args={[0.04, 0.04, 3.2, 6]} /><meshBasicMaterial color="#334155" transparent opacity={0.45} /></mesh>
          <Label at={[0, 3.7, 0]}>
            <div className="label3d village"><b>{v.name}</b>{v.wet && <small>raining</small>}</div>
          </Label>
        </group>
      ))}
    </>
  );
}

/** A marker over the field a view wants you to look at. */
export function Pin({ at }: { at: XZ }) {
  const g = useRef<THREE.Group>(null!);
  useFrame((s) => { g.current.position.y = 1.5 + 0.2 * Math.sin(s.clock.elapsedTime * 3); });
  return (
    <group position={[at[0], 0, at[1]]}>
      <group ref={g}>
        <mesh rotation={[Math.PI, 0, 0]}><coneGeometry args={[0.32, 0.9, 14]} /><meshLambertMaterial color="#111827" /></mesh>
        <mesh position={[0, 0.55, 0]}><sphereGeometry args={[0.36, 16, 12]} /><meshLambertMaterial color="#111827" /></mesh>
      </group>
    </group>
  );
}
