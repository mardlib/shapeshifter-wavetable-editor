import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import ShapeshifterStudio from "../app/ShapeshifterStudio";
import "../app/globals.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ShapeshifterStudio />
  </StrictMode>,
);
