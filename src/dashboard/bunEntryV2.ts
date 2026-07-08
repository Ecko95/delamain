import { runOpenTuiDashboardV2 } from "./opentuiV2.js";
import { runOpenTuiDashboardV3 } from "./opentuiV3.js";
import { runOpenTuiDashboardV3Classic } from "./opentuiV3Classic.js";

const which = process.env.DELAMAIN_DASHBOARD;
if (which === "v2") {
  await runOpenTuiDashboardV2();
} else if (which === "v3-classic" || which === "classic") {
  await runOpenTuiDashboardV3Classic();
} else {
  await runOpenTuiDashboardV3();
}
