import { useEffect, useState } from "react";
import type { Projector } from "../sim/geo";

/** Satellite photo of the block, stitched from map tiles, laid on the ground of the 3D scene. */
export type Ground = { canvas: HTMLCanvasElement; x: number; z: number; w: number; d: number; version: number };

// Esri World Imagery: no key needed, sends CORS headers. Attribution is shown on the map.
const TILES = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
export const IMAGERY_CREDIT = "Imagery © Esri, Maxar, Earthstar Geographics";
const TILE = 256, MAX_TILES = 620;

const lon2x = (lon: number, z: number) => ((lon + 180) / 360) * 2 ** z;
const lat2y = (lat: number, z: number) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};
const x2lon = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
const y2lat = (y: number, z: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;

/** A little brighter and greener than the raw imagery, so fields and machines stand out on it. */
const TREAT = "brightness(1.16) saturate(1.22) contrast(1.04)";

/**
 * @param maxTiles how many tiles the mosaic may use; the sharpest zoom that fits is chosen
 * @param fade     fade the mosaic's edges to transparent (for a photo that ends in open ground)
 */
export function useSatellite(project: Projector | null, bbox: [number, number, number, number] | null,
                             { maxTiles = MAX_TILES, fade = false }: { maxTiles?: number; fade?: boolean } = {}): Ground | null {
  const [ground, setGround] = useState<Ground | null>(null);
  const key = bbox ? `${bbox.map((v) => v.toFixed(4)).join(",")}|${maxTiles}|${fade}` : undefined;

  useEffect(() => {
    if (!project || !bbox) return;
    const [w, s, e, n] = bbox;
    // sharpest zoom that keeps the mosaic to a sensible number of tiles
    let z = 16, x0 = 0, x1 = 0, y0 = 0, y1 = 0;
    for (; z > 8; z--) {
      x0 = Math.floor(lon2x(w, z)) - 1; x1 = Math.floor(lon2x(e, z)) + 1;
      y0 = Math.floor(lat2y(n, z)) - 1; y1 = Math.floor(lat2y(s, z)) + 1;
      if ((x1 - x0 + 1) * (y1 - y0 + 1) <= maxTiles) break;
    }
    const nx = x1 - x0 + 1, ny = y1 - y0 + 1;
    const canvas = document.createElement("canvas");
    canvas.width = nx * TILE; canvas.height = ny * TILE;
    const g = canvas.getContext("2d")!;
    g.fillStyle = "#93a476"; // farmland green until a tile arrives
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.filter = TREAT;

    // the scene's projection is linear in lon/lat; over ~12 km the Mercator difference is under a metre
    const [ax, az] = project([x2lon(x0, z), y2lat(y0, z)]);
    const [bx, bz] = project([x2lon(x1 + 1, z), y2lat(y1 + 1, z)]);
    const place = { x: (ax + bx) / 2, z: (az + bz) / 2, w: bx - ax, d: bz - az };

    let live = true, done = 0, version = 0;
    const publish = () => live && setGround({ canvas, ...place, version: ++version });
    const finish = () => {
      if (!fade) return publish();
      g.filter = "none";
      const m = Math.min(canvas.width, canvas.height) * 0.12;
      g.globalCompositeOperation = "destination-out";
      for (const [x, y, gw, gh, x1g, y1g, x2g, y2g] of [
        [0, 0, canvas.width, m, 0, 0, 0, m], [0, canvas.height - m, canvas.width, m, 0, canvas.height, 0, canvas.height - m],
        [0, 0, m, canvas.height, 0, 0, m, 0], [canvas.width - m, 0, m, canvas.height, canvas.width, 0, canvas.width - m, 0],
      ]) {
        const grad = g.createLinearGradient(x1g, y1g, x2g, y2g);
        grad.addColorStop(0, "rgba(0,0,0,1)"); grad.addColorStop(1, "rgba(0,0,0,0)");
        g.fillStyle = grad; g.fillRect(x, y, gw, gh);
      }
      g.globalCompositeOperation = "source-over";
      publish();
    };
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const img = new Image();
        img.crossOrigin = "anonymous";
        const settle = () => {
          if (!live) return;
          done++;
          if (done === nx * ny) finish();
          else if (done % 96 === 0) publish();
        };
        img.onload = () => { if (live) g.drawImage(img, (tx - x0) * TILE, (ty - y0) * TILE); settle(); };
        img.onerror = settle; // a missing tile just stays the neutral ground colour
        img.src = TILES.replace("{z}", String(z)).replace("{y}", String(ty)).replace("{x}", String(tx));
      }
    }
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, key]);

  return ground;
}
