import { useParams } from "react-router-dom";
import { fmtDate, machineName } from "../api";
import { useFetch } from "../state";

type Cert = { cert_id: string; field_id: string; village_name: string; cleared_on: string; method: string; machine_id: string; status: string; image_dates: string[]; synthetic: boolean; footer: string };

const CHECK: Record<string, string> = {
  pending_check: "Satellite no-burn check pending — it needs two clear images after clearance.",
  no_burn_detected: "No burn scar detected in satellite imagery.",
  burn_detected: "Satellite imagery shows a possible burn scar after clearance.",
};

/** Public page behind the QR code on a clearance certificate. */
export function Verify() {
  const { certId } = useParams();
  const { data, error } = useFetch<Cert>(`/verify/${certId}`);
  return (
    <div className="verify">
      <article className="cert">
        <span className="eyebrow">StrawLink · clearance certificate</span>
        {error && <><h1>Certificate not found</h1><p className="note">No certificate has the number {certId}.</p></>}
        {!data && !error && <p className="note">Checking…</p>}
        {data && (
          <>
            <h1>Field {data.field_id}, {data.village_name}</h1>
            <dl>
              <dt>Certificate</dt><dd className="num">{data.cert_id}</dd>
              <dt>Cleared on</dt><dd>{fmtDate(data.cleared_on)}</dd>
              <dt>Method</dt><dd>{data.method === "bale" ? "Baled and hauled to a plant" : "Wheat seeded into the straw (Super Seeder)"}</dd>
              <dt>Machine</dt><dd>{data.machine_id ? machineName(data.machine_id) : "—"}</dd>
              <dt>No-burn check</dt>
              <dd>
                {CHECK[data.status] ?? data.status}
                {data.image_dates.length > 0 && <div className="muted num">Images: {data.image_dates.join(", ")}</div>}
              </dd>
            </dl>
            {data.synthetic && <p><span className="tag">demo data</span></p>}
            <p className="foot">{data.footer}</p>
          </>
        )}
      </article>
    </div>
  );
}
