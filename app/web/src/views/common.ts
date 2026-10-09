import type { Cell } from "../sim/geo";
import type { Look } from "../sim/stage";

/** A field's look straight from its status in the API. */
export const byStatus = (c: Cell): Look =>
  ({ forecast: "paddy", ready: "straw", scheduled: "sched", cleared: "soil", at_risk: "risk", wet: "wet" } as const)[c.props.status] ?? "straw";

/** Same, but "machine coming today" is left to the plan being played (StrawLink or baseline). */
export const beforePlan = (c: Cell): Look => (c.props.status === "scheduled" ? "straw" : byStatus(c));

export function legend(cells: Cell[], look: (c: Cell) => Look, order: Look[], labels: Partial<Record<Look, string>> = {}): { look: Look; label?: string; n?: number }[] {
  const n = new Map<Look, number>();
  for (const c of cells) { const l = look(c); n.set(l, (n.get(l) ?? 0) + 1); }
  return order.map((l) => ({ look: l, n: n.get(l) ?? 0, label: labels[l] }));
}

export const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
