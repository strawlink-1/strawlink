import { useSyncExternalStore } from "react";

/** Viewer preferences, remembered on this device. */
export type Prefs = { satellite: boolean };

const KEY = "strawlink.prefs";
function load(): Prefs {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "{}").satellite;
    return { satellite: saved === undefined ? true : !!saved };
  } catch {
    return { satellite: true };
  }
}

let prefs = load();
const subs = new Set<() => void>();

export const prefStore = {
  get: () => prefs,
  set(next: Partial<Prefs>) {
    prefs = { ...prefs, ...next };
    try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* private window: preference just is not kept */ }
    subs.forEach((f) => f());
  },
  subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f); }; },
};

export const usePrefs = () => useSyncExternalStore(prefStore.subscribe, prefStore.get);
