import { Component, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import "./app.css";
import { Verify } from "./screens/Verify";
import { WorldProvider } from "./sim/world";
import { AppProvider } from "./state";
import "./ui/prefs";
import { Shell } from "./ui/Shell";

function Home() {
  const { search } = useLocation();
  return <Navigate to={`/simulator${search}`} replace />;
}

/** Last line of defence: an error anywhere shows a message and a reload button, never a blank page. */
class Crash extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) { return { error: String((e as Error)?.message ?? e) }; }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div id="loading" className="fatal">
        <p><b>StrawLink hit an error.</b></p>
        <p>{this.state.error}</p>
        <button type="button" className="btn ghost sm" onClick={() => location.reload()}>Reload</button>
      </div>
    );
  }
}

createRoot(document.getElementById("root")!).render(
  <Crash>
  <AppProvider>
    <BrowserRouter>
      <Routes>
        <Route path="/verify/:certId" element={<Verify />} />
        {/* one shell for every view: the 3D scene stays mounted while the view changes */}
        <Route path="/:view" element={<WorldProvider><Shell /></WorldProvider>} />
        <Route path="*" element={<Home />} />
      </Routes>
    </BrowserRouter>
  </AppProvider>
  </Crash>,
);
