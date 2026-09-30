/** 独立演示入口。 */
import React from "react";
import { createRoot } from "react-dom/client";
import { DagWorkbench } from "./DagWorkbench.js";
import "./style.css";
import "./demo.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <DagWorkbench />
  </React.StrictMode>,
);
