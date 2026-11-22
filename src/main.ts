import { checkSupport } from "unkernel";
import { ClusterManager } from "./cluster/cluster-manager";
import { ChaosPanel } from "./ui/chaos-panel";
import { TelemetryView } from "./ui/telemetry-chart";
import { TerminalDrawer } from "./ui/terminal-drawer";
import { TopologyView } from "./ui/topology-view";

const el = {
  supportBadge: document.getElementById("support-badge")!,
  clusterBadge: document.getElementById("cluster-badge")!,
  nodeCount: document.getElementById("node-count") as HTMLSelectElement,
  btnBoot: document.getElementById("btn-boot-cluster") as HTMLButtonElement,
  btnStop: document.getElementById("btn-stop-cluster") as HTMLButtonElement,
  statusLine: document.getElementById("status-line")!,
  topoSummary: document.getElementById("topo-summary")!,
  topoSvg: document.getElementById("topo-svg")!,
  nodeCards: document.getElementById("node-cards")!,
  chaosRoot: document.getElementById("chaos-root")!,
  telemetryRoot: document.getElementById("telemetry-root")!,
  termDrawer: document.getElementById("term-drawer")!,
  drawerTitle: document.getElementById("drawer-title")!,
  tabBar: document.getElementById("tab-bar")!,
  terminalStage: document.getElementById("terminal-stage")!,
  terminalEmpty: document.getElementById("terminal-empty")!,
  btnNewTab: document.getElementById("btn-new-tab") as HTMLButtonElement,
  btnCtrlC: document.getElementById("btn-ctrl-c") as HTMLButtonElement,
  btnCloseDrawer: document.getElementById("btn-close-drawer") as HTMLButtonElement,
  quickChips: [...document.querySelectorAll<HTMLButtonElement>("#term-drawer .chip")],
};

const cluster = new ClusterManager();

const drawer = new TerminalDrawer({
  cluster,
  drawerEl: el.termDrawer,
  titleEl: el.drawerTitle,
  tabBar: el.tabBar,
  stage: el.terminalStage,
  emptyEl: el.terminalEmpty,
  btnNewTab: el.btnNewTab,
  btnCtrlC: el.btnCtrlC,
  btnClose: el.btnCloseDrawer,
  quickChips: el.quickChips,
});

const topology = new TopologyView({
  svgHost: el.topoSvg,
  cardsHost: el.nodeCards,
  vSwitch: cluster.vSwitch,
  actions: {
    onToggleLink: (nodeId, linkUp) => {
      cluster.setNodeLink(nodeId, linkUp);
      topology.renderSvg();
    },
    onKillRaft: (nodeId) => void cluster.killRaftProcess(nodeId),
    onStartRaft: (nodeId) => void cluster.startRaftProcess(nodeId),
    onPowerCut: (nodeId) => cluster.powerCutNode(nodeId),
    onRebootNode: (nodeId) => void cluster.rebootNode(nodeId),
    onOpenTerminal: (nodeId) => drawer.open(nodeId),
  },
});

const chaosPanel = new ChaosPanel({
  root: el.chaosRoot,
  cluster,
});

const telemetry = new TelemetryView(el.telemetryRoot);

cluster.setEvents({
  onBootProgress: (msg) => {
    el.statusLine.textContent = msg;
  },
  onNodesChanged: (nodes) => {
    topology.updateNodes(nodes);
    chaosPanel.updateNodes(nodes);
    telemetry.updateNodes(nodes);

    const running = nodes.filter((n) => n.lifecycle === "running").length;
    const leader = nodes.find(
      (n) => n.lifecycle === "running" && n.raftStatus?.role === "Leader"
    );
    const maxTerm = nodes.reduce(
      (acc, n) => Math.max(acc, n.raftStatus?.term ?? 0),
      0
    );

    if (nodes.length === 0) {
      el.clusterBadge.textContent = "Idle";
      el.clusterBadge.className = "badge badge-muted";
      el.topoSummary.textContent = "等待启动...";
    } else {
      el.clusterBadge.textContent = `${running}/${nodes.length} Running`;
      el.clusterBadge.className =
        running === nodes.length ? "badge badge-ok" : "badge badge-warn";
      el.topoSummary.textContent = `Leader: ${
        leader ? leader.config.label : "选举中..."
      } | Term: ${maxTerm || "-"}`;
    }
  },
  onSwitchTelemetry: (snap) => {
    topology.updateSwitchTelemetry(snap);
    telemetry.updateSwitchTelemetry(snap);
  },
  onTimelineEvent: (ev) => {
    telemetry.pushEvent(ev);
  },
  onWorkloadChanged: (stats) => {
    chaosPanel.updateWorkload(stats);
  },
});

async function initSupportCheck(): Promise<void> {
  const report = await checkSupport();
  if (report.ok) {
    el.supportBadge.textContent = "JSPI Ready";
    el.supportBadge.className = "badge badge-ok";
  } else {
    el.supportBadge.textContent = "Unsupported Browser";
    el.supportBadge.className = "badge badge-err";
    el.btnBoot.disabled = true;
    el.statusLine.textContent = `缺少浏览器支持: ${report.problems.join(
      "; "
    )}. 需要 Chrome/Edge 137+, Firefox 153+, 或 Safari 27+.`;
  }
}

el.btnBoot.addEventListener("click", async () => {
  const count = Number(el.nodeCount.value) || 3;
  el.btnBoot.disabled = true;
  el.nodeCount.disabled = true;
  el.btnStop.disabled = false;
  telemetry.reset();
  drawer.close();
  el.statusLine.textContent = `正在启动 ${count} 个独立 Web Worker Linux 节点...`;

  try {
    await cluster.bootCluster(count);
    el.statusLine.textContent = `${count} 节点 Raft 集群已就绪！数据面经由 Virtual L2 Switch，控制面经由独立 vsock。`;
  } catch (err: any) {
    el.statusLine.textContent = `集群启动失败: ${err?.message ?? err}`;
    el.btnBoot.disabled = false;
    el.nodeCount.disabled = false;
  }
});

el.btnStop.addEventListener("click", async () => {
  el.btnStop.disabled = true;
  drawer.close();
  await cluster.stopCluster();
  el.btnBoot.disabled = false;
  el.nodeCount.disabled = false;
  el.statusLine.textContent = "集群已停止。";
});

topology.render();
void initSupportCheck();
