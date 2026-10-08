import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { Shell } from "./components/Shell";
import { Backtest } from "./screens/Backtest";
import { Factory } from "./screens/Factory";
import { Farmer } from "./screens/Farmer";
import { Operator } from "./screens/Operator";
import { Verify } from "./screens/Verify";
import { AppProvider } from "./state";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/verify/:certId" element={<Verify />} />
          <Route
            path="*"
            element={
              <Shell>
                <Routes>
                  <Route path="/operator" element={<Operator />} />
                  <Route path="/factory" element={<Factory />} />
                  <Route path="/farmer" element={<Farmer />} />
                  <Route path="/backtest" element={<Backtest />} />
                  <Route path="*" element={<Navigate to={`/operator${location.search}`} replace />} />
                </Routes>
              </Shell>
            }
          />
        </Routes>
      </BrowserRouter>
    </AppProvider>
  </StrictMode>,
);
