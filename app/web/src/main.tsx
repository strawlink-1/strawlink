import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { AppProvider } from "./state";
import "./styles.css";

// each screen loads its own heavy library (three.js for /live, MapLibre for the 2D screens)
const MovieScreen = lazy(() => import("./movie/MovieScreen").then((m) => ({ default: m.MovieScreen })));
const Shell = lazy(() => import("./components/Shell").then((m) => ({ default: m.Shell })));
const Operator = lazy(() => import("./screens/Operator").then((m) => ({ default: m.Operator })));
const Factory = lazy(() => import("./screens/Factory").then((m) => ({ default: m.Factory })));
const Farmer = lazy(() => import("./screens/Farmer").then((m) => ({ default: m.Farmer })));
const Backtest = lazy(() => import("./screens/Backtest").then((m) => ({ default: m.Backtest })));
const Verify = lazy(() => import("./screens/Verify").then((m) => ({ default: m.Verify })));

const Loading = () => <div style={{ display: "grid", placeItems: "center", height: "100%", font: "600 16px var(--display)" }}>Loading StrawLink…</div>;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppProvider>
      <BrowserRouter>
        <Suspense fallback={<Loading />}>
          <Routes>
            <Route path="/verify/:certId" element={<Verify />} />
            <Route path="/live" element={<MovieScreen />} />
            <Route
              path="*"
              element={
                <Shell>
                  <Suspense fallback={<Loading />}>
                    <Routes>
                      <Route path="/operator" element={<Operator />} />
                      <Route path="/factory" element={<Factory />} />
                      <Route path="/farmer" element={<Farmer />} />
                      <Route path="/backtest" element={<Backtest />} />
                      <Route path="*" element={<Navigate to={`/live${location.search}`} replace />} />
                    </Routes>
                  </Suspense>
                </Shell>
              }
            />
          </Routes>
        </Suspense>
      </BrowserRouter>
    </AppProvider>
  </StrictMode>,
);
