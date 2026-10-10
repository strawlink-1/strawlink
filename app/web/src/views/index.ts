import type { ComponentType } from "react";
import { Air } from "./Air";
import { Farmers } from "./Farmers";
import { Forecast } from "./Forecast";
import { Plants } from "./Plants";
import { Results } from "./Results";
import { Simulator } from "./Simulator";

/** One entry per page tab. Each page fills the side panel and tells the shared map what to show. */
export const PAGES: { id: string; label: string; title: string; Component: ComponentType }[] = [
  { id: "simulator", label: "Simulator", title: "Set up a day and run it", Component: Simulator },
  { id: "forecast", label: "Forecast", title: "When each field will be harvested", Component: Forecast },
  { id: "plants", label: "Plants", title: "Where the straw goes", Component: Plants },
  { id: "farmers", label: "Farmers", title: "What a farmer sees on WhatsApp", Component: Farmers },
  { id: "air", label: "Air", title: "Who is downwind of fields with no machine", Component: Air },
  { id: "results", label: "2025 test", title: "The 2025 season replayed", Component: Results },
];
