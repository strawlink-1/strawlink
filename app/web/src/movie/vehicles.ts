/**
 * Procedural vehicle models (metres, +z = forward). Built from primitives so they stay light and
 * stylised; each returns the animated parts the scene drives every frame.
 */
import * as THREE from "three";

export type Rig = {
  root: THREE.Group;
  wheels: { mesh: THREE.Object3D; r: number }[];
  rotor?: THREE.Object3D;
  plunger?: THREE.Object3D;
  load?: THREE.Group;
  beacon?: THREE.Mesh;
};

const paint = (c: string) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.42, metalness: 0.35 });
const matte = (c: string, r = 0.85) => new THREE.MeshStandardMaterial({ color: c, roughness: r, metalness: 0.05 });
const TIRE = matte("#1b1b1b", 0.95);
const STEEL = new THREE.MeshStandardMaterial({ color: "#9aa1a6", roughness: 0.35, metalness: 0.85 });
const GLASS = new THREE.MeshStandardMaterial({ color: "#a9d3e6", roughness: 0.08, metalness: 0.2, transparent: true, opacity: 0.45 });
const BLACK = matte("#26282a", 0.6);

function box(w: number, h: number, d: number, m: THREE.Material, x = 0, y = 0, z = 0) {
  const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
  b.position.set(x, y, z);
  b.castShadow = true;
  b.receiveShadow = true;
  return b;
}

function wheel(r: number, w: number, rim: THREE.Material) {
  const g = new THREE.Group();
  const tire = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w, 22), TIRE);
  tire.rotation.z = Math.PI / 2;
  tire.castShadow = true;
  // tread lugs so rotation is visible
  for (let i = 0; i < 10; i++) {
    const lug = new THREE.Mesh(new THREE.BoxGeometry(w * 1.02, r * 0.16, r * 0.22), TIRE);
    const a = (i / 10) * Math.PI * 2;
    lug.position.set(0, Math.sin(a) * r, Math.cos(a) * r);
    lug.rotation.x = -a;
    g.add(lug);
  }
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.55, r * 0.55, w * 1.04, 16), rim);
  hub.rotation.z = Math.PI / 2;
  g.add(tire, hub);
  return g;
}

/** Tractor body. Returns rig with wheels; front at +z, rear axle at z=0. */
export function tractor(color: string, accent: string): Rig {
  const root = new THREE.Group();
  const body = paint(color);
  const rim = paint(accent);
  root.add(box(1.1, 0.9, 2.6, body, 0, 1.25, 1.55)); // hood
  root.add(box(1.0, 0.2, 0.2, BLACK, 0, 1.1, 2.9)); // grille
  root.add(box(1.4, 0.35, 1.4, body, 0, 1.0, 0)); // seat base
  // cab: four posts + roof + glass
  const cab = new THREE.Group();
  for (const [x, z] of [[-0.75, -0.65], [0.75, -0.65], [-0.75, 0.65], [0.75, 0.65]]) cab.add(box(0.08, 1.6, 0.08, BLACK, x, 2.0, z));
  cab.add(box(1.75, 0.12, 1.6, body, 0, 2.85, 0));
  cab.add(box(1.5, 1.4, 1.35, GLASS, 0, 2.0, 0));
  root.add(cab);
  const exhaust = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1.3, 8), STEEL);
  exhaust.position.set(0.42, 2.2, 2.2);
  root.add(exhaust);
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8), new THREE.MeshStandardMaterial({ color: "#ffb300", emissive: "#ff9900", emissiveIntensity: 1.5 }));
  beacon.position.set(0, 3.0, 0);
  root.add(beacon);
  const wheels: Rig["wheels"] = [];
  for (const side of [-1, 1]) {
    const rear = wheel(0.85, 0.5, rim);
    rear.position.set(side * 0.95, 0.85, 0);
    const front = wheel(0.48, 0.32, rim);
    front.position.set(side * 0.75, 0.48, 2.45);
    root.add(rear, front);
    wheels.push({ mesh: rear, r: 0.85 }, { mesh: front, r: 0.48 });
  }
  return { root, wheels, beacon };
}

/** Tractor + trailing square baler (bales drop out of the back chute). */
export function balerSet(color: string, accent: string): Rig {
  const t = tractor(color, accent);
  const baler = new THREE.Group();
  const shell = paint(accent);
  baler.add(box(1.5, 1.5, 4.4, shell, 0.55, 1.35, -3.6)); // bale chamber
  baler.add(box(2.4, 0.5, 0.9, shell, -0.2, 0.55, -1.75)); // pickup header
  baler.add(box(0.12, 0.12, 1.8, STEEL, 0, 0.9, -0.9)); // drawbar
  const plunger = box(1.2, 0.5, 0.6, BLACK, 0.55, 2.25, -2.2); // flywheel housing (bobs while baling)
  baler.add(plunger);
  baler.add(box(1.0, 0.1, 1.2, STEEL, 0.55, 0.85, -6.1)); // chute
  root(t).add(baler);
  for (const side of [-1, 1]) {
    const w = wheel(0.45, 0.3, STEEL);
    w.position.set(0.55 + side * 0.95, 0.45, -3.9);
    baler.add(w);
    t.wheels.push({ mesh: w, r: 0.45 });
  }
  t.plunger = plunger;
  return t;
}

/** Tractor + rear-mounted Super Seeder (rotor + seed box). */
export function superSeeder(color: string, accent: string): Rig {
  const t = tractor(color, accent);
  const imp = new THREE.Group();
  const shell = paint(accent);
  imp.add(box(2.7, 0.7, 1.0, shell, 0, 0.75, -1.5)); // rotor hood
  const rotor = new THREE.Group();
  const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 2.6, 12), STEEL);
  drum.rotation.z = Math.PI / 2;
  rotor.add(drum);
  for (let i = 0; i < 14; i++) {
    const blade = box(0.06, 0.55, 0.12, STEEL, -1.2 + (i * 2.4) / 13, 0, 0);
    blade.rotation.x = i * 0.9;
    rotor.add(blade);
  }
  rotor.position.set(0, 0.42, -1.5);
  imp.add(rotor);
  imp.add(box(2.6, 0.75, 0.75, paint("#2a5aa0"), 0, 1.55, -1.75)); // seed + fertiliser box
  imp.add(box(2.7, 0.1, 0.5, STEEL, 0, 0.35, -2.2)); // press roller
  t.root.add(imp);
  t.rotor = rotor;
  return t;
}

/** Tractor-trolley — the workhorse of Punjab straw haulage. Load shows when carrying bales. */
export function tractorTrolley(color: string, accent: string): Rig {
  const t = tractor(color, accent);
  const trolley = new THREE.Group();
  const shell = paint(accent);
  trolley.add(box(2.4, 0.25, 5.2, BLACK, 0, 1.05, -4.4)); // bed
  for (const side of [-1, 1]) trolley.add(box(0.1, 1.1, 5.2, shell, side * 1.2, 1.7, -4.4));
  trolley.add(box(2.4, 1.1, 0.1, shell, 0, 1.7, -7.0));
  trolley.add(box(2.4, 1.1, 0.1, shell, 0, 1.7, -1.8));
  trolley.add(box(0.12, 0.12, 1.6, STEEL, 0, 0.95, -1.0)); // hitch
  for (const z of [-3.6, -5.2]) for (const side of [-1, 1]) {
    const w = wheel(0.5, 0.35, STEEL);
    w.position.set(side * 1.05, 0.5, z);
    trolley.add(w);
    t.wheels.push({ mesh: w, r: 0.5 });
  }
  const load = new THREE.Group();
  const baleMat = matte("#e3c065", 0.95);
  for (let y = 0; y < 3; y++) for (let x = 0; x < 2; x++) for (let z = 0; z < 4; z++) {
    const b = box(1.1, 0.75, 1.2, baleMat, -0.57 + x * 1.14, 1.55 + y * 0.78, -2.5 - z * 1.25);
    b.rotation.y = (Math.random() - 0.5) * 0.06;
    load.add(b);
  }
  trolley.add(load);
  t.root.add(trolley);
  t.load = load;
  return t;
}

function root(r: Rig) {
  return r.root;
}
