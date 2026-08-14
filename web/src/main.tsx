import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { applyIdentity, readIdentity } from "./lib/identity.ts";
import "./styles.css";

// Before the first paint, so an opted-in reader never sees a mono frame first.
applyIdentity(readIdentity());

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
