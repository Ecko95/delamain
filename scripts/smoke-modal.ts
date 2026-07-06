// Test-only smoke entry: seeds a modal (or palette via MODE=palette) and renders once
// under CODEX_PEERS_DASHBOARD_SMOKE=1, then idle-exits. Uses real peers on this machine.
import { listPeers } from "../src/peerManager.js";
import { runOpenTuiDashboardV3 } from "../src/dashboard/opentuiV3.js";

const mode = process.env.MODE || "modal";
const firstPeer = listPeers()[0];

await runOpenTuiDashboardV3((state) => {
  if (mode === "palette") {
    state.mode = "palette";
    state.paletteQuery = "";
    return;
  }
  if (mode === "help") {
    state.mode = "help";
    return;
  }
  state.mode = "modal";
  state.modalPeerId = firstPeer?.id;
  state.selectedPeerId = firstPeer?.id;
  state.modalOpenedAt = Date.now() - 1000;
  state.modalTab = 0;
});
