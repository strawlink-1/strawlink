import { useEffect, useRef, useState } from "react";
import { get, type FC } from "../api";
import { useApp } from "../state";
import { buildWorld, type MachineRow, type PlanJSON, type RoutesFC, type SupplyJSON, type World } from "./model";
import { loadRoads } from "./roadnet";

export type Change = { id: number; at: number; text: string; fields: string[]; kind: "replan" | "status" | "first" };

const POLL_MS = 5000;

/**
 * Loads everything the film needs and keeps polling. When the plan id or any field status changes,
 * the world is rebuilt (the scene animates to the new state) and a Change is emitted for the HUD.
 */
export function useWorld(policy: "strawlink" | "baseline") {
  const { meta, date, version } = useApp();
  const [world, setWorld] = useState<World | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [changes, setChanges] = useState<Change[]>([]);
  const prev = useRef<{ planId: string; status: Map<string, string>; slots: Map<string, string> } | null>(null);
  const seq = useRef(0);
  const scope = useRef("");

  useEffect(() => {
    if (!meta || !date) return;
    let alive = true;
    let timer: number | undefined;
    if (scope.current !== `${date}|${policy}`) {
      prev.current = null; // new date/policy: start a fresh comparison (demo actions keep it, so changes show)
      scope.current = `${date}|${policy}`;
    }

    const load = async (full: boolean) => {
      try {
        const q = `date=${date}`;
        const plan = await get<PlanJSON>(`/plan?${q}&policy=${policy}`).catch(() => null);
        const p0 = prev.current;
        if (!full && p0 && plan && plan.plan_id === p0.planId) {
          // cheap check on statuses only
          const fc = await get<FC>(`/fields?${q}`);
          const changed = fc.features.filter((f) => p0.status.get(f.properties.field_id) !== f.properties.status).map((f) => f.properties.field_id);
          if (!changed.length) return;
        }
        const [fields, machines, routes, supply, roads] = await Promise.all([
          get<FC>(`/fields?${q}`),
          get<{ machines: MachineRow[] }>(`/machines?${q}`).then((r) => r.machines),
          plan ? get<RoutesFC>(`/routes?${q}&policy=${policy}`).catch(() => null) : Promise.resolve(null),
          get<SupplyJSON>(`/plants/supply?weeks=1&${q}`).catch(() => null),
          loadRoads(),
        ]);
        if (!alive) return;
        const w = buildWorld({ meta, fields, plan, routes, machines, supply, roads });
        const status = new Map(fields.features.map((f) => [f.properties.field_id, f.properties.status]));
        const slots = new Map(fields.features.map((f) => [f.properties.field_id, f.properties.slot ? `${f.properties.slot.machine_id}@${f.properties.slot.arrive}` : ""]));
        if (p0) {
          const changedStatus = [...status].filter(([k, v]) => p0.status.get(k) !== v).map(([k]) => k);
          const byNew = new Map<string, number>();
          for (const k of changedStatus) byNew.set(status.get(k)!, (byNew.get(status.get(k)!) ?? 0) + 1);
          const LABEL: Record<string, string> = { wet: "too wet after rain", scheduled: "scheduled", ready: "ready", cleared: "cleared", at_risk: "at risk", forecast: "back to forecast" };
          const statusText = [...byNew].map(([s, n]) => `${n} ${LABEL[s] ?? s}`).join(" · ");
          const changedSlots = [...slots].filter(([k, v]) => p0.slots.get(k) !== v).map(([k]) => k);
          const all = [...new Set([...changedStatus, ...changedSlots])];
          if (w.planId !== p0.planId || all.length) {
            const text = w.planId !== p0.planId
              ? `Re-planned · ${w.totals.fields_planned} fields, ${w.totals.tonnes_planned.toFixed(0)} t today · ${changedSlots.length} slots moved${statusText ? ` · ${statusText}` : ""}`
              : `Live update · ${statusText}`;
            const kind = (w.planId !== p0.planId ? "replan" : "status") as Change["kind"];
            // fold quick successive updates into one card
            setChanges((c) => {
              const recent = c[0] && Date.now() - c[0].at < 8000 && c[0].kind !== "first";
              const merged: Change = recent
                ? { id: c[0].id, at: Date.now(), text, fields: [...new Set([...c[0].fields, ...all])], kind: kind === "replan" || c[0].kind === "replan" ? "replan" : "status" }
                : { id: ++seq.current, at: Date.now(), text, fields: all, kind };
              return [merged, ...(recent ? c.slice(1) : c)].slice(0, 6);
            });
          }
        } else {
          setChanges([{ id: ++seq.current, at: Date.now(), text: `Loaded plan ${w.planId || "(none)"} for ${w.date}`, fields: [], kind: "first" }]);
        }
        prev.current = { planId: w.planId, status, slots };
        setWorld(w);
        setError(null);
      } catch (e) {
        if (alive) setError(String((e as Error).message ?? e));
      }
    };

    load(prev.current === null);
    timer = window.setInterval(() => load(false), POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [meta, date, policy, version]);

  return { world, error, changes };
}
