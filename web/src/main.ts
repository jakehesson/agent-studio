import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/studio.css";
import "./styles/views.css";
import "./styles/responsive.css";

import { AgentStudioApp } from "./app.js";

const mountEl = document.getElementById("app");
if (mountEl) {
  new AgentStudioApp(mountEl);
}
