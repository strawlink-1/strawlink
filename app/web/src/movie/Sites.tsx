import { useFrame } from "@react-three/fiber";
import { useMemo } from "react";
import * as THREE from "three";
import { clock } from "./clock";
import { rng, hash } from "./geo";
import { plantFillAt, type World } from "./model";

// ---------------------------------------------------------------- processing plants

function plantModel(name: string) {
  const g = new THREE.Group();
  const wall = new THREE.MeshStandardMaterial({ color: "#d7d2c8", roughness: 0.8 });
  const roof = new THREE.MeshStandardMaterial({ color: "#4f7fa6", roughness: 0.5, metalness: 0.4 });
  const steel = new THREE.MeshStandardMaterial({ color: "#8e979c", roughness: 0.4, metalness: 0.7 });
  const add = (m: THREE.Mesh) => { m.castShadow = true; m.receiveShadow = true; g.add(m); return m; };
  // main shed with a saw-tooth roof
  add(new THREE.Mesh(new THREE.BoxGeometry(60, 14, 34), wall)).position.set(0, 7, 0);
  for (let i = 0; i < 5; i++) {
    const tooth = add(new THREE.Mesh(new THREE.BoxGeometry(12, 4, 34.5), roof));
    tooth.position.set(-24 + i * 12, 15.5, 0);
    tooth.rotation.z = 0.32;
  }
  const isCbg = /cbg/i.test(name);
  if (isCbg) {
    // biogas digesters: green domes
    for (let i = 0; i < 2; i++) {
      const tank = add(new THREE.Mesh(new THREE.CylinderGeometry(9, 9, 10, 24), new THREE.MeshStandardMaterial({ color: "#3e7b5a", roughness: 0.6 })));
      tank.position.set(45, 5, -12 + i * 24);
      const dome = add(new THREE.Mesh(new THREE.SphereGeometry(9, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshStandardMaterial({ color: "#d9d9d0", roughness: 0.5 })));
      dome.position.set(45, 10, -12 + i * 24);
    }
  } else {
    const silo = add(new THREE.Mesh(new THREE.CylinderGeometry(5, 5, 22, 20), steel));
    silo.position.set(42, 11, 8);
  }
  const chimney = add(new THREE.Mesh(new THREE.CylinderGeometry(1.6, 2.2, 42, 16), new THREE.MeshStandardMaterial({ color: "#b44d3a", roughness: 0.7 })));
  chimney.position.set(-24, 21, -10);
  const band = add(new THREE.Mesh(new THREE.CylinderGeometry(1.75, 1.75, 2, 16), new THREE.MeshStandardMaterial({ color: "#f2f2f2" })));
  band.position.set(-24, 38, -10);
  // depot yard slab
  const yard = add(new THREE.Mesh(new THREE.BoxGeometry(70, 0.4, 50), new THREE.MeshStandardMaterial({ color: "#a39a88", roughness: 1 })));
  yard.position.set(0, 0.2, 48);
  return g;
}

export function Plants({ world }: { world: World }) {
  const items = useMemo(
    () =>
      world.plants.map((p) => {
        const model = plantModel(p.name);
        model.position.set(p.pos[0], 0, p.pos[1]);
        const stack = new THREE.InstancedMesh(new THREE.BoxGeometry(2.2, 1.2, 3.4).translate(0, 0.6, 0), new THREE.MeshStandardMaterial({ color: "#e2c169", roughness: 0.95 }), 900);
        stack.castShadow = true;
        stack.receiveShadow = true;
        stack.position.set(p.pos[0], 0.4, p.pos[1] + 48);
        const puffs = Array.from({ length: 16 }, () => ({ y: -1, x: 0, z: 0, s: 0, life: 0 }));
        const puffMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), new THREE.MeshStandardMaterial({ color: "#f4f1ea", transparent: true, opacity: 0.65, roughness: 1 }), puffs.length);
        puffMesh.position.set(p.pos[0] - 24, 42, p.pos[1] - 10);
        return { p, model, stack, puffs, puffMesh, lastDeliveries: 0 };
      }),
    [world.plants],
  );
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), v = new THREE.Vector3();

  useFrame((_, dtRaw) => {
    const dt = Math.min(dtRaw, 0.1);
    for (const it of items) {
      const fill = plantFillAt(it.p, clock.t);
      const share = Math.min(1, fill / Math.max(1, it.p.depot));
      const n = Math.round(share * 720);
      for (let i = 0; i < n; i++) {
        const layer = Math.floor(i / 144), r = i % 144;
        const x = (r % 24) * 2.5 - 30, z = Math.floor(r / 24) * 3.6 - 10;
        it.stack.setMatrixAt(i, m4.compose(v.set(x, layer * 1.25, z), q, s.set(1, 1, 1)));
      }
      it.stack.count = n;
      it.stack.instanceMatrix.needsUpdate = true;
      // steam: steady wisps, and a burst whenever a delivery lands
      const delivered = it.p.deliveries.filter((d) => clock.t >= d.t).length;
      const burst = delivered > it.lastDeliveries;
      it.lastDeliveries = delivered;
      it.puffs.forEach((pf, i) => {
        if (pf.life <= 0 && (Math.random() < dt * 1.5 || burst)) Object.assign(pf, { y: 0, x: 0, z: 0, s: 2 + Math.random() * 2, life: 1 });
        if (pf.life > 0) {
          pf.life -= dt * 0.25;
          pf.y += dt * 6;
          pf.x += dt * 3;
          pf.s += dt * 2.5;
        }
        const sc = pf.life > 0 ? pf.s : 0;
        it.puffMesh.setMatrixAt(i, m4.compose(v.set(pf.x, pf.y, pf.z), q, s.set(sc, sc, sc)));
      });
      it.puffMesh.instanceMatrix.needsUpdate = true;
    }
  });

  return (
    <>
      {items.map((it) => (
        <group key={it.p.id}>
          <primitive object={it.model} />
          <primitive object={it.stack} />
          <primitive object={it.puffMesh} />
        </group>
      ))}
    </>
  );
}

// ---------------------------------------------------------------- rain over wet villages

export function Rain({ world }: { world: World }) {
  const wetVillages = useMemo(() => {
    const by = new Map<string, { x: number; z: number; n: number }>();
    for (const f of world.fields) {
      if (f.status !== "wet") continue;
      const v = by.get(f.village) ?? { x: 0, z: 0, n: 0 };
      v.x += f.center[0]; v.z += f.center[1]; v.n++;
      by.set(f.village, v);
    }
    return [...by.entries()].map(([id, v]) => ({ id, x: v.x / v.n, z: v.z / v.n }));
  }, [world.fields]);

  const sys = useMemo(() => {
    const per = 1800;
    const N = per * Math.max(1, wetVillages.length);
    const pos = new Float32Array(N * 6);
    const seeds = new Float32Array(N * 3);
    wetVillages.forEach((v, vi) => {
      const R = rng(hash(v.id));
      for (let i = 0; i < per; i++) {
        const k = vi * per + i;
        const a = R() * Math.PI * 2, d = Math.sqrt(R()) * 650;
        seeds[k * 3] = v.x + Math.cos(a) * d;
        seeds[k * 3 + 1] = R() * 260;
        seeds[k * 3 + 2] = v.z + Math.sin(a) * d;
      }
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const lines = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: "#c9d8ee", transparent: true, opacity: 0.55 }));
    lines.frustumCulled = false;
    const clouds = new THREE.Group();
    const cloudMat = new THREE.MeshStandardMaterial({ color: "#a7b0ba", roughness: 1, transparent: true, opacity: 0.5, depthWrite: false, flatShading: false });
    wetVillages.forEach((v) => {
      const R = rng(hash(v.id) + 9);
      for (let i = 0; i < 18; i++) {
        const c = new THREE.Mesh(new THREE.IcosahedronGeometry(1, 3), cloudMat);
        c.position.set(v.x + (R() - 0.5) * 1100, 620 + R() * 120, v.z + (R() - 0.5) * 1100);
        c.scale.set(200 + R() * 160, 28 + R() * 22, 170 + R() * 140);
        c.renderOrder = 5;
        clouds.add(c);
      }
    });
    return { lines, pos, seeds, N, clouds };
  }, [wetVillages]);

  useFrame((state) => {
    if (!wetVillages.length) return;
    const time = state.clock.elapsedTime;
    const { pos, seeds, N } = sys;
    for (let i = 0; i < N; i++) {
      const y = 600 - ((seeds[i * 3 + 1] * 2.2 + time * 160) % 600);
      const x = seeds[i * 3] + time * 6, z = seeds[i * 3 + 2];
      pos.set([x, y, z, x + 1.5, y - 9, z], i * 6);
    }
    sys.lines.geometry.attributes.position.needsUpdate = true;
  });

  if (!wetVillages.length) return null;
  return (
    <>
      <primitive object={sys.lines} />
      <primitive object={sys.clouds} />
    </>
  );
}
