import { useParams } from "react-router-dom";
import { fmtDate } from "../api";
import { useFetch } from "../state";

type Cert = { cert_id: string; field_id: string; village_name: string; cleared_on: string; method: string; machine_id: string; status: string; image_dates: string[]; synthetic: boolean; footer: string };

const STATUS: Record<string, string> = {
  pending_check: "Satellite no-burn check pending — needs two clear images after clearance.",
  no_burn_detected: "No burn scar detected in satellite imagery.",
  burn_detected: "Satellite imagery shows a possible burn scar after clearance.",
};

export function Verify() {
  const { certId } = useParams();
  const { data, error } = useFetch<Cert>(`/verify/${certId}`);
  return (
    <div className="page" style={{ maxWidth: 640, margin: "0 auto" }}>
      <h1>Clearance certificate</h1>
      {error && <div className="alert">Certificate {certId} was not found.</div>}
      {data && (
        <article className="card">
          <div className="muted num">{data.cert_id}</div>
          <h2 style={{ fontSize: 28 }}>{data.field_id} · {data.village_name}</h2>
          <dl className="why" style={{ display: "grid", gridTemplateColumns: "140px 1fr", gap: "8px 12px" }}>
            <dt className="muted">Cleared on</dt><dd style={{ margin: 0 }}>{fmtDate(data.cleared_on)}</dd>
            <dt className="muted">Method</dt><dd style={{ margin: 0 }}>{data.method === "bale" ? "Baled and hauled to a plant" : "Super Seeder (in place)"}</dd>
            <dt className="muted">Machine</dt><dd style={{ margin: 0 }}>{data.machine_id ?? "—"}</dd>
            <dt className="muted">No-burn check</dt>
            <dd style={{ margin: 0 }}>
              {STATUS[data.status] ?? data.status}
              {data.image_dates.length > 0 && <div className="muted num" style={{ fontSize: 12 }}>Images: {data.image_dates.join(", ")}</div>}
            </dd>
          </dl>
          {data.synthetic && <p><span className="synthetic-tag">demo data</span></p>}
          <p className="muted" style={{ fontStyle: "italic", fontSize: 13 }}>{data.footer}</p>
        </article>
      )}
    </div>
  );
}
