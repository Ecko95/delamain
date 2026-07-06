import { runOpenTuiDashboardV2 } from "./opentuiV2.js";
import { runOpenTuiDashboardV3 } from "./opentuiV3.js";

if (process.env.DELAMAIN_DASHBOARD === "v2") {
  await runOpenTuiDashboardV2();
} else {
  await runOpenTuiDashboardV3();
}
