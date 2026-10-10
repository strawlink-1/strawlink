import { useMemo } from "react";
import { fmtDate } from "../api";
import { pullIn, type XZ } from "../sim/geo";
import { useStageMode, type AirLayer } from "../sim/stage";
import { useWorld } from "../sim/world";
import { useApp, useFetch } from "../state";
import { Count, Group, InPanel, Legend, Stat, Tip } from "../ui/kit";
import { byStatus } from "./common";

type Exposure = {
  label: string;
  wind: { wind_from_deg: number; wind_speed_kmh: number; hours: string; date?: string; requested_date?: string };
  rule: { max_km: number; sector_deg: number };
  risk_fields: string[];
  exposed: { kind: string; name: string; location: [number, number]; nearest_km: number; from_fields: string[] }[];
};
type Emissions = {
  status: string; message?: string; formula: string; tonnes: number; note?: string;
  combustion_factor?: { value: number; source: string | null };
  pollutants?: { pollutant: string; label: string; kg: number; g_per_kg: number; source: string | null }[];
};
const weight = (kg: number) => (kg >= 1000 ? `${(kg / 1000).toFixed(kg >= 10000 ? 0 : 1)} t` : `${Math.round(kg)} kg`);

const COMPASS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];

/** Who is downwind? Fields with no machine, the afternoon wind, and the villages and schools in its path. */
export function Air() {
  const { cells, cellById, geo, today, plan } = useWorld();
  const { version } = useApp();
  const ex = useFetch<Exposure>(today ? `/exposure?date=${today}` : null, [version]);
  // the straw the simulator's current plan clears today: what would burning it instead put in the air?
  const planned = plan?.totals.tonnes_planned ?? 0;
  const em = useFetch<Emissions>(today && plan ? `/emissions?date=${today}&tonnes=${planned}` : null, [version, planned]);
  const data = ex.data;

  const air = useMemo<AirLayer | null>(() => {
    if (!data || !geo) return null;
    return {
      windTo: (data.wind.wind_from_deg + 180) % 360,
      sectorDeg: data.rule.sector_deg,
      sources: data.risk_fields.flatMap((id) => { const c = cellById.get(id); return c ? [[c.x, c.z] as XZ] : []; }),
      places: [...data.exposed].sort((a, b) => a.nearest_km - b.nearest_km).slice(0, 5).map((p) => {
        const at = pullIn(geo.project(p.location), geo.box, 4);
        return { name: p.name, kind: p.kind, at: at.at, km: p.nearest_km, moved: at.moved };
      }),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, geo, cellById.size]);
  const keep = useMemo(() => (data ? new Set(data.risk_fields) : null), [data]);
  useStageMode(() => ({
    look: byStatus,
    keep,
    air,
    villageLabels: false,
    camera: { key: "air", polar: 0.78, azim: 0.4, dist: (geo?.span ?? 100) * 1.25 },
  }), [keep, air, geo]);

  const schools = data?.exposed.filter((p) => p.kind === "school").length ?? 0;
  const from = data?.wind.wind_from_deg ?? 0;
  const substitute = data?.wind.date && data.wind.requested_date && data.wind.date !== data.wind.requested_date;

  return (
    <InPanel>
      <h1>Who is downwind?</h1>
      <p className="lede">If the fields still waiting for a machine were burned this afternoon, these are the villages and schools the smoke would reach first. It shows where a machine matters most for people's health.</p>
      {ex.error && <p className="note warn">Wind data is unavailable right now ({ex.error}).</p>}
      {!data && !ex.error && <p className="note">Reading the wind forecast…</p>}
      {data && (
        <>
          <div className="compass">
            <svg viewBox="-50 -50 100 100" role="img" aria-label={`Wind from ${Math.round(from)} degrees`}>
              <circle r="44" className="ring" />
              {[0, 90, 180, 270].map((a) => <line key={a} x1="0" y1="-44" x2="0" y2="-38" transform={`rotate(${a})`} className="tick" />)}
              <text y="-27" textAnchor="middle">N</text>
              {/* the arrow points where the wind is going */}
              <g transform={`rotate(${from + 180})`}><path d="M0 -30 L9 -10 L3 -12 L3 26 L-3 26 L-3 -12 L-9 -10 Z" className="needle" /></g>
            </svg>
            <div className="c-txt">
              <b>{data.wind.wind_speed_kmh} km/h</b>
              wind from the {COMPASS[Math.round(from / 45) % 8]}
              <small>{data.wind.hours} · Open-Meteo{substitute ? ` forecast for ${fmtDate(data.wind.date)}, the furthest day available` : ""}</small>
            </div>
          </div>
          <div className="stat-row">
            <Stat k="places downwind" v={<Count value={data.exposed.length} />} tone="risk" tip={`Villages and schools within ${data.rule.max_km} km and ±${data.rule.sector_deg}° of the wind direction from any of the highlighted fields.`} />
            <Stat k="of them schools" v={<Count value={schools} />} tone="warn" />
          </div>
          <Group title="On the map">
            <Legend items={[{ look: "straw", label: "No machine yet (highest priority)", n: keep?.size ?? 0 }, { look: "dim", label: "Other fields", n: cells.length - (keep?.size ?? 0) }]} />
            <p className="note">Grey streaks show the wind. Orange fans show where smoke would drift. This is exposure if the fields burn — <b>not a pollution reading</b>, and never used to report anyone.</p>
          </Group>

          <Group title="Nearest places in the path" aside="OpenStreetMap">
            <ol className="rank">
              {[...data.exposed].sort((a, b) => a.nearest_km - b.nearest_km).slice(0, 6).map((p, i) => (
                <li key={p.kind + p.name + i}>
                  <span className="n">{i + 1}</span>
                  <span className="t">{p.name || "Unnamed place"}<small>{p.kind === "school" ? "School" : "Village"} · downwind of {p.from_fields.length} field{p.from_fields.length === 1 ? "" : "s"}</small></span>
                  <span className="v num">{p.nearest_km.toFixed(1)} km</span>
                </li>
              ))}
            </ol>
            {!data.exposed.length && <p className="note">No village or school is inside the downwind fans today.</p>}
          </Group>
        </>
      )}
      <Group title="If this straw were burned" aside="upper estimate">
        {em.data?.status === "ok" && em.data.pollutants ? (
          <>
            <p className="note">
              The simulator's current plan clears <b>{em.data.tonnes.toFixed(0)} t</b> of straw today. Burned in the field instead, it would put about this much into the air:
            </p>
            <ul className="rank">
              {em.data.pollutants.map((r) => (
                <li key={r.pollutant}>
                  <span className="n" />
                  <span className="t">
                    <Tip text={`${em.data!.tonnes.toFixed(0)} t of straw × ${em.data!.combustion_factor?.value} burnt (${em.data!.combustion_factor?.source}) × ${r.g_per_kg} g per kg (${r.source}).`}>{r.label}</Tip>
                  </span>
                  <span className="v num">{weight(r.kg)}</span>
                </li>
              ))}
            </ul>
            <p className="note">{em.data.note}</p>
          </>
        ) : (
          <p className="note">
            {em.data?.status === "pending_source"
              ? <>Not shown yet. <Tip text={em.data.formula}>The formula</Tip> is ready, but the emission factors still need a cited source; we would rather show nothing than an invented number.</>
              : em.error ? `Estimate unavailable (${em.error}).` : "Working it out…"}
          </p>
        )}
      </Group>
    </InPanel>
  );
}
