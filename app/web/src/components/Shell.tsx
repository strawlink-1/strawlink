import { useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { useApp } from "../state";
import { DemoConsole } from "./DemoConsole";

export function Shell({ children }: { children: ReactNode }) {
  const { meta, metaError } = useApp();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  const keep = loc.search;
  const demo = new URLSearchParams(loc.search).has("demo");
  return (
    <div className="shell">
      <header className="topbar">
        <NavLink to={`/operator${keep}`} className="brand" aria-label="StrawLink home">
          <b>StrawLink</b>
          <span>Sangrur block · demo</span>
        </NavLink>
        <nav className="nav" aria-label="Screens">
          <NavLink to={`/live${keep}`}>Live 3D</NavLink>
          <NavLink to={`/operator${keep}`}>Operator</NavLink>
          <NavLink to={`/factory${keep}`}>Factory</NavLink>
          <NavLink to={`/farmer${keep}`}>Farmer</NavLink>
          <NavLink to={`/backtest${keep}`}>Backtest</NavLink>
        </nav>
        <div className="tools">
          <span className="synthetic-tag" title="Fleet, plants, phones and parcel boundaries are synthetic">synthetic inputs</span>
          <button className="btn" onClick={() => setOpen(true)}>Assumptions</button>
        </div>
      </header>
      {metaError && (
        <div className="alert" style={{ margin: 12 }}>
          Can't reach the StrawLink API ({metaError}). Check VITE_API_URL and that the backend is deployed.
        </div>
      )}
      {children}
      {open && meta && (
        <>
          <div className="drawer-backdrop" onClick={() => setOpen(false)} />
          <aside className="drawer" role="dialog" aria-label="Assumptions">
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <h2>Assumptions</h2>
              <button className="btn" onClick={() => setOpen(false)}>Close</button>
            </div>
            <p className="muted">
              Every value below is an assumption or synthetic input, not a measured fact. They come from the files listed, so each number
              in the app traces back to one of them.
            </p>
            <table className="data">
              <thead><tr><th>Input</th><th>Value</th></tr></thead>
              <tbody>
                {meta.assumptions.map((a) => (
                  <tr key={a.key}>
                    <td>
                      <b>{a.key}</b>
                      <div className="muted" style={{ fontSize: 12 }}>{a.note} · <span className="num">{a.source}</span></div>
                    </td>
                    <td className="num">{a.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {meta.forecast_report?.validation && (
              <p style={{ fontSize: 13 }}>
                Forecast model, 2025 validation ({meta.forecast_report.validation.n} forecasts): median-date error{" "}
                <b className="num">{meta.forecast_report.validation.p50_mae_days} days</b>; only{" "}
                <b className="num">{Math.round(meta.forecast_report.validation.coverage_p10_p90 * 100)}%</b> of harvests fell inside the 80% range
                — the range is too narrow and is being recalibrated.
              </p>
            )}
          </aside>
        </>
      )}
      {demo && <DemoConsole />}
    </div>
  );
}
