import maplibregl, { type GeoJSONSource, type StyleSpecification } from "maplibre-gl";
import { useEffect, useRef } from "react";
import { MAPS_KEY, MAPS_REGION, type FC } from "../api";

export type Overlay = {
  routes?: GeoJSON.FeatureCollection | null;
  exposure?: { location: [number, number]; name: string; kind: string }[] | null;
  plants?: { plant_id: string; name: string; location: [number, number] }[];
  villages?: { name: string; coordinates: [number, number] }[];
};

const FALLBACK: StyleSpecification = {
  version: 8,
  glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      attribution: "© OpenStreetMap contributors",
    },
  },
  layers: [{ id: "osm", type: "raster", source: "osm", paint: { "raster-saturation": -0.6, "raster-opacity": 0.85 } }],
};

function styleUrl() {
  return MAPS_KEY
    ? `https://maps.geo.${MAPS_REGION}.amazonaws.com/v2/styles/Hybrid/descriptor?key=${MAPS_KEY}`
    : structuredClone(FALLBACK); // MapLibre mutates style objects; never share one between maps
}

const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim() || "#888";

function statusColor(): maplibregl.ExpressionSpecification {
  return [
    "match", ["get", "status"],
    "forecast", css("--forecast"),
    "ready", css("--ready"),
    "scheduled", ["match", ["get", "route"], "seed", css("--seed"), css("--bale")],
    "cleared", css("--cleared"),
    "at_risk", css("--risk"),
    "wet", css("--wet"),
    css("--forecast"),
  ];
}

export function FieldMap({
  fc, selected, onSelect, overlay, dim,
}: {
  fc: FC | null;
  selected?: string | null;
  onSelect?: (id: string) => void;
  overlay?: Overlay;
  dim?: (p: FC["features"][number]["properties"]) => boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  const ready = useRef(false);
  const fitted = useRef(false);
  const onSel = useRef(onSelect);
  onSel.current = onSelect;

  useEffect(() => {
    if (!box.current) return;
    ready.current = false;
    fitted.current = false;
    const m = new maplibregl.Map({
      container: box.current,
      style: styleUrl(),
      center: [75.735, 30.365],
      zoom: 12.4,
      attributionControl: { compact: true },
      cooperativeGestures: false,
      canvasContextAttributes: { preserveDrawingBuffer: true }, // lets screenshots/print capture the map
    });
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    m.on("load", () => {
      m.addSource("fields", { type: "geojson", data: { type: "FeatureCollection", features: [] }, promoteId: "field_id" });
      m.addSource("routes", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      m.addSource("pois", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      m.addSource("plants", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
      m.addLayer({ id: "fields-fill", type: "fill", source: "fields", paint: { "fill-color": statusColor(), "fill-opacity": ["case", ["boolean", ["get", "_dim"], false], 0.15, 0.78] } });
      m.addLayer({ id: "fields-line", type: "line", source: "fields", paint: { "line-color": "#1e2a24", "line-width": 0.6, "line-opacity": 0.6 } });
      m.addLayer({ id: "fields-sel", type: "line", source: "fields", filter: ["==", ["get", "field_id"], ""], paint: { "line-color": "#ffffff", "line-width": 3 } });
      m.addLayer({
        id: "routes", type: "line", source: "routes",
        paint: { "line-color": ["match", ["get", "type"], "seeder", css("--seed"), css("--bale")], "line-width": 3, "line-dasharray": [2, 1] },
      });
      m.addLayer({
        id: "pois", type: "circle", source: "pois",
        paint: { "circle-radius": ["match", ["get", "kind"], "school", 6, 5], "circle-color": css("--risk"), "circle-stroke-color": "#fff", "circle-stroke-width": 2 },
      });
      m.addLayer({ id: "plants", type: "circle", source: "plants", paint: { "circle-radius": 8, "circle-color": "#1e2a24", "circle-stroke-color": css("--bale"), "circle-stroke-width": 3 } });
      m.on("click", "fields-fill", (e) => {
        const id = e.features?.[0]?.properties?.field_id;
        if (id) onSel.current?.(id);
      });
      m.on("mouseenter", "fields-fill", () => (m.getCanvas().style.cursor = "pointer"));
      m.on("mouseleave", "fields-fill", () => (m.getCanvas().style.cursor = ""));
      const pop = new maplibregl.Popup({ closeButton: false, closeOnClick: false, offset: 8 });
      for (const layer of ["pois", "plants"]) {
        m.on("mouseenter", layer, (e) => {
          const p = e.features?.[0]?.properties as { name?: string; kind?: string };
          pop.setLngLat(e.lngLat).setText(`${p.name ?? ""}${p.kind ? ` · ${p.kind}` : ""}`).addTo(m);
        });
        m.on("mouseleave", layer, () => pop.remove());
      }
      ready.current = true;
      m.fire("strawlink:ready");
    });
    map.current = m;
    if (import.meta.env.DEV) (window as unknown as { __slmap: maplibregl.Map }).__slmap = m;
    const ro = new ResizeObserver(() => m.resize());
    ro.observe(box.current);
    return () => {
      ro.disconnect();
      m.remove();
    };
  }, []);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const apply = () => {
      if (!fc) return;
      const data = { ...fc, features: fc.features.map((f) => ({ ...f, properties: { ...f.properties, _dim: dim ? dim(f.properties) : false } })) };
      (m.getSource("fields") as GeoJSONSource).setData(data as GeoJSON.FeatureCollection);
      m.setPaintProperty("fields-fill", "fill-color", statusColor());
      if (!fitted.current && fc.features.length) {
        const b = new maplibregl.LngLatBounds();
        for (const f of fc.features) for (const c of (f.geometry as GeoJSON.Polygon).coordinates[0]) b.extend(c as [number, number]);
        m.fitBounds(b, { padding: 40, duration: 0 });
        fitted.current = true;
      }
    };
    if (ready.current) apply();
    else m.once("strawlink:ready", apply);
  }, [fc, dim]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const apply = () => {
      (m.getSource("routes") as GeoJSONSource).setData(overlay?.routes ?? { type: "FeatureCollection", features: [] });
      (m.getSource("pois") as GeoJSONSource).setData({
        type: "FeatureCollection",
        features: (overlay?.exposure ?? []).map((p) => ({ type: "Feature", geometry: { type: "Point", coordinates: p.location }, properties: { name: p.name, kind: p.kind } })),
      });
      (m.getSource("plants") as GeoJSONSource).setData({
        type: "FeatureCollection",
        features: (overlay?.plants ?? []).map((p) => ({ type: "Feature", geometry: { type: "Point", coordinates: p.location }, properties: { name: p.name, kind: "plant (synthetic)" } })),
      });
    };
    if (ready.current) apply();
    else m.once("strawlink:ready", apply);
  }, [overlay]);

  useEffect(() => {
    const m = map.current;
    if (!m) return;
    const apply = () => m.setFilter("fields-sel", ["==", ["get", "field_id"], selected ?? ""]);
    if (ready.current) apply();
    else m.once("strawlink:ready", apply);
  }, [selected]);

  return <div ref={box} className="map" role="region" aria-label="Map of fields" />;
}
