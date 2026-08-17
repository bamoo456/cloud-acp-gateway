import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { applyIdentity, readIdentity } from "./lib/identity.ts";
import { applyTheme, readTheme } from "./lib/theme.ts";
// Self-hosted, not a CDN: the gateway is routinely reached over a LAN with no
// way out. Only the latin subsets are fetched (unicode-range decides), and
// italics are synthesised rather than shipped as a second file.
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";

// Before the first paint, so an opted-in reader never sees a mono frame first.
applyIdentity(readIdentity());
applyTheme(readTheme());

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
