import { Component, useEffect, useState, type ReactNode } from "react";
import { NavLink, useLocation, useParams } from "react-router-dom";
import { API, machineName } from "../api";
import { LabelLayer } from "../scene/Label";
import { IMAGERY_CREDIT } from "../scene/satellite";
import { Stage3D } from "../scene/Stage3D";
import { sheet, useSheet } from "../sim/stage";
import { useWorld } from "../sim/world";
import { PAGES } from "../views";
import { FieldCard } from "./FieldCard";
import { Guard, Icon, Slots } from "./kit";
import { prefStore, usePrefs } from "./prefs";

/**
 * The frame every page shares: page tabs across the top, a side panel on the left, and the 3D map
 * with one strip above it and one below. Nothing floats over the map except what the user opened.
 */
export function Shell() {
  const { view } = useParams();
  const page = PAGES.find((p) => p.id === view) ?? PAGES[0];
  const world = useWorld();
  const prefs = usePrefs();
  const showSheet = useSheet();
  const { search } = useLocation();
  const [panel, setPanel] = useState<HTMLElement | null>(null);
  const [above, setAbove] = useState<HTMLElement | null>(null);
  const [below, setBelow] = useState<HTMLElement | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!world.toast) return;
    setToast(world.toast.text);
    const id = setTimeout(() => setToast(null), 3800);
    return () => clearTimeout(id);
  }, [world.toast]);

  return (
    <div id="app">
      <header id="top">
        <NavLink to={`/simulator${search}`} className="brand">
          <span className="mark" aria-hidden />
          <b>StrawLink</b>
          <span className="where">Sangrur block, Punjab</span>
        </NavLink>
        <nav id="tabs" aria-label="Pages">
          {PAGES.map((p) => (
            <NavLink key={p.id} to={`/${p.id}${search}`} className={() => (p.id === page.id ? "on" : "")} aria-current={p.id === page.id ? "page" : undefined} title={p.title}>
              {p.label}
            </NavLink>
          ))}
        </nav>
        <button type="button" className="quiet" onClick={() => sheet.set(true)}>What is real here?</button>
      </header>

      <aside id="side" aria-label={page.title}><div id="side-inner" ref={setPanel} /></aside>

      <main id="main">
        <div id="above" ref={setAbove} />
        <div id="stage">
          {world.ready && <MapGuard><Stage3D /></MapGuard>}
          <div id="labels" aria-hidden><LabelLayer /></div>
          <div id="tags" aria-hidden />
          {world.ready && prefs.satellite && <div id="credit">{IMAGERY_CREDIT}</div>}

          {world.ready && (
            <div id="mapbar">
              {world.follow ? (
                <button type="button" className="on" onClick={() => world.setFollow(null)}><Icon name="eye" size={15} /> Following {machineName(world.follow)} · stop</button>
              ) : (
                <span className="muted">Drag to turn · scroll to zoom · click a field or a machine</span>
              )}
              <label className="check" title="Lay the real satellite photo under the fields (Esri World Imagery)">
                <input type="checkbox" checked={prefs.satellite} onChange={(e) => prefStore.set({ satellite: e.target.checked })} /> Satellite photo
              </label>
            </div>
          )}
          {world.selected && <FieldCard key={world.selected} id={world.selected} />}
          {toast && <div id="toast" role="status">{toast}</div>}
          {!world.ready && (
            <div id="loading" className={world.error ? "fatal" : ""}>
              {world.error ? (
                <>
                  <p><b>Can't reach the StrawLink API.</b></p>
                  <p>{world.error}</p>
                  <p>Looking at <code>{API}</code>. Start the backend, or set <code>VITE_API_URL</code>.</p>
                </>
              ) : (
                <><span className="spin big" /><p>Loading the block…</p></>
              )}
            </div>
          )}
          {showSheet && <Truth onClose={() => sheet.set(false)} />}
        </div>
        <div id="below" ref={setBelow} />
      </main>

      <Slots.Provider value={{ panel, above, below }}>
        {world.ready && <Guard key={page.id}><page.Component /></Guard>}
      </Slots.Provider>
    </div>
  );
}

class MapGuard extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) { return { error: String((e as Error)?.message ?? e) }; }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div id="loading" className="fatal">
        <p><b>The map could not be drawn.</b></p>
        <p>{this.state.error}</p>
        <button type="button" className="btn ghost sm" onClick={() => location.reload()}>Reload</button>
      </div>
    );
  }
}

/** What is real, approximate and synthetic, and every assumed constant, straight from the config files. */
function Truth({ onClose }: { onClose: () => void }) {
  const { meta } = useWorld();
  return (
    <div id="overlay" onClick={onClose}>
      <section className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="What is real and what is assumed">
        <header>
          <h3>What is real, approximate and synthetic</h3>
          <button type="button" className="x" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        </header>
        <div className="sheet-body">
          <div className="truth">
            <div><b className="ok">Real</b><span>Sentinel-2 satellite imagery and the harvest and burn signals taken from it, weather and wind (Open-Meteo), roads, villages and schools (OpenStreetMap), and the planner that answers the sliders.</span></div>
            <div><b className="warn">Approximate</b><span>{meta?.fields_note ?? "Field outlines are 110 m grid parcels placed on real paddy pixels, not surveyed boundaries."}</span></div>
            <div><b className="risk">Synthetic</b><span>Machines, plants, phone numbers and combine bookings. Replace the config files with real ones and every page uses them.</span></div>
          </div>
          <table className="data">
            <thead><tr><th>Assumed input</th><th>Value</th></tr></thead>
            <tbody>
              {meta?.assumptions.map((a) => (
                <tr key={a.key}>
                  <td><b>{a.key}</b><small>{a.note} · {a.source}</small></td>
                  <td className="num">{a.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
