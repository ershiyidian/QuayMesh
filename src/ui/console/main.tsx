import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { migrateLegacyLocation } from "./router.js";
import { applyTheme } from "./theme.js";
import "./app.css";

applyTheme();
migrateLegacyLocation();

const container = document.getElementById("root");
if (container) createRoot(container).render(<App />);
