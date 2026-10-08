import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { get, type Meta } from "./api";

type Ctx = {
  meta: Meta | null;
  metaError: string | null;
  date: string;
  setDate: (d: string) => void;
  version: number;
  bump: () => void;
};

const AppCtx = createContext<Ctx | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [metaError, setMetaError] = useState<string | null>(null);
  const [date, setDate] = useState<string>("");
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => {
    get<Meta>("/meta")
      .then((m) => {
        setMeta(m);
        setDate((d) => d || new URLSearchParams(location.search).get("date") || m.plan_date);
      })
      .catch((e) => setMetaError(String(e)));
  }, []);
  return <AppCtx.Provider value={{ meta, metaError, date, setDate, version, bump }}>{children}</AppCtx.Provider>;
}

export function useApp() {
  const c = useContext(AppCtx);
  if (!c) throw new Error("useApp outside provider");
  return c;
}

export function useFetch<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!path) return;
    let live = true;
    setLoading(true);
    get<T>(path)
      .then((d) => live && (setData(d), setError(null)))
      .catch((e) => live && setError(String(e.message ?? e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);
  return { data, error, loading };
}
