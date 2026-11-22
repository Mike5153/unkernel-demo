import type { VirtualL2Switch } from "../cluster/switch";
import type {
  NodeId,
  NodeRuntimeState,
  SwitchTelemetrySnapshot,
} from "../cluster/types";

export interface TopologyActions {
  onToggleLink: (nodeId: NodeId, linkUp: boolean) => void;
  onKillRaft: (nodeId: NodeId) => void;
  onStartRaft: (nodeId: NodeId) => void;
  onPowerCut: (nodeId: NodeId) => void;
  onRebootNode: (nodeId: NodeId) => void;
  onOpenTerminal: (nodeId: NodeId) => void;
}

interface Point {
  x: number;
  y: number;
}

export class TopologyView {
  readonly #svgHost: HTMLElement;
  readonly #cardsHost: HTMLElement;
  readonly #vSwitch: VirtualL2Switch;
  readonly #actions: TopologyActions;

  #nodes: NodeRuntimeState[] = [];
  #switchSnap: SwitchTelemetrySnapshot | null = null;

  constructor(opts: {
    svgHost: HTMLElement;
    cardsHost: HTMLElement;
    vSwitch: VirtualL2Switch;
    actions: TopologyActions;
  }) {
    this.#svgHost = opts.svgHost;
    this.#cardsHost = opts.cardsHost;
    this.#vSwitch = opts.vSwitch;
    this.#actions = opts.actions;
  }

  updateNodes(nodes: NodeRuntimeState[]): void {
    this.#nodes = nodes;
    this.render();
  }

  updateSwitchTelemetry(snap: SwitchTelemetrySnapshot): void {
    this.#switchSnap = snap;
    this.renderSvg();
  }

  render(): void {
    this.renderSvg();
    this.renderCards();
  }

  #computePositions(count: number): Point[] {
    const cx = 320;
    const cy = 165;
    const rx = count <= 3 ? 175 : 190;
    const ry = count <= 3 ? 105 : 115;
    const pts: Point[] = [];
    for (let i = 0; i < count; i++) {
      const angle = -Math.PI / 2 + (2 * Math.PI * i) / count;
      pts.push({
        x: cx + rx * Math.cos(angle),
        y: cy + ry * Math.sin(angle),
      });
    }
    return pts;
  }

  renderSvg(): void {
    if (this.#nodes.length === 0) {
      this.#svgHost.innerHTML = `<div class="topo-empty">点击右上角 <strong>Boot Cluster</strong> 启动 3~5 个独立 Linux Wasm 节点并组建 Raft 集群</div>`;
      return;
    }

    const pts = this.#computePositions(this.#nodes.length);
    const now = performance.now();
    const linkStatsMap = new Map(
      (this.#switchSnap?.links ?? []).map((l) => [l.key, l])
    );

    const linksSvg: string[] = [];
    for (let i = 0; i < this.#nodes.length; i++) {
      for (let j = i + 1; j < this.#nodes.length; j++) {
        const a = this.#nodes[i]!;
        const b = this.#nodes[j]!;
        const p1 = pts[i]!;
        const p2 = pts[j]!;

        const ruleAB = this.#vSwitch.getRule(a.config.nodeId, b.config.nodeId);
        const ruleBA = this.#vSwitch.getRule(b.config.nodeId, a.config.nodeId);
        const statAB = linkStatsMap.get(`${a.config.nodeId}->${b.config.nodeId}`);
        const statBA = linkStatsMap.get(`${b.config.nodeId}->${a.config.nodeId}`);

        const nodeDeadOrDown =
          a.lifecycle === "dead" ||
          b.lifecycle === "dead" ||
          !a.linkUp ||
          !b.linkUp;
        const severed = ruleAB.severed || ruleBA.severed || nodeDeadOrDown;
        const maxDelay = Math.max(ruleAB.delayMs, ruleBA.delayMs);
        const maxDrop = Math.max(ruleAB.dropRate, ruleBA.dropRate);
        const hasRetransFlash =
          !severed &&
          ((statAB && now - statAB.lastRetransmitAt < 700) ||
            (statBA && now - statBA.lastRetransmitAt < 700));

        let stroke = "#334155";
        let dash = "";
        let width = "2";
        let extraClass = "";

        if (severed) {
          stroke = "#ef4444";
          dash = "6 5";
          width = "2";
        } else if (hasRetransFlash) {
          stroke = "#f43f5e";
          width = "3.5";
          extraClass = "link-retrans-flash";
        } else if (maxDrop > 0 || maxDelay > 0) {
          stroke = "#f59e0b";
          width = "2.5";
        } else if (a.lifecycle === "running" && b.lifecycle === "running") {
          stroke = "#2563eb";
          width = "2";
        }

        const mx = (p1.x + p2.x) / 2;
        const my = (p1.y + p2.y) / 2;

        const tags: string[] = [];
        if (!a.linkUp || !b.linkUp) tags.push("NO LINK");
        else if (ruleAB.severed || ruleBA.severed) tags.push("SEVERED");
        else {
          if (maxDelay > 0) tags.push(`${maxDelay}ms`);
          if (maxDrop > 0) tags.push(`${Math.round(maxDrop * 100)}% loss`);
          const rtt = statAB?.rttMs ?? statBA?.rttMs ?? null;
          if (tags.length === 0 && rtt !== null) {
            tags.push(`${rtt.toFixed(0)}ms RTT`);
          }
        }
        if (hasRetransFlash) tags.push("RETRANS!");

        const labelText = tags.join(" · ");
        linksSvg.push(`
          <line x1="${p1.x}" y1="${p1.y}" x2="${p2.x}" y2="${p2.y}"
                stroke="${stroke}" stroke-width="${width}" stroke-dasharray="${dash}"
                class="${extraClass}" stroke-opacity="0.85" />
          ${
            labelText
              ? `<g transform="translate(${mx}, ${my})">
                  <rect x="-46" y="-10" width="92" height="19" rx="4" fill="#0b0f14" fill-opacity="0.92" stroke="${
                    hasRetransFlash ? "#f43f5e" : severed ? "#ef4444" : "#243041"
                  }" stroke-width="1"/>
                  <text text-anchor="middle" y="3" font-size="10" font-family="ui-monospace, monospace" fill="${
                    hasRetransFlash ? "#fda4af" : severed ? "#fca5a5" : "#cbd5e1"
                  }">${labelText}</text>
                </g>`
              : ""
          }
        `);
      }
    }

    const nodesSvg = this.#nodes.map((n, i) => {
      const p = pts[i]!;
      const role = n.raftStatus?.role ?? "Unknown";
      let ringColor = "#475569";
      let fill = "#0f172a";
      let roleText = n.lifecycle === "booting" ? "Booting" : "Offline";
      let pulse = "";

      if (n.lifecycle === "dead") {
        ringColor = "#ef4444";
        fill = "#1f1215";
        roleText = "POWER OFF";
      } else if (n.lifecycle === "error") {
        ringColor = "#ef4444";
        roleText = "ERROR";
      } else if (n.lifecycle === "running") {
        if (!n.raftRunning) {
          ringColor = "#f43f5e";
          roleText = "PID KILLED";
        } else if (role === "Leader") {
          ringColor = "#22c55e";
          fill = "#0c2217";
          roleText = "LEADER";
          pulse = `<circle cx="${p.x}" cy="${p.y}" r="36" fill="none" stroke="#22c55e" stroke-width="2" class="leader-pulse"/>`;
        } else if (role === "Candidate") {
          ringColor = "#f59e0b";
          fill = "#241b0a";
          roleText = "CANDIDATE";
        } else {
          ringColor = "#3b82f6";
          fill = "#0f1c31";
          roleText = "FOLLOWER";
        }
      }

      const term = n.raftStatus?.term ?? "-";
      const ci = n.raftStatus?.commitIndex ?? "-";
      const ai = n.raftStatus?.appliedIndex ?? "-";
      const linkWarn = !n.linkUp
        ? `<rect x="${p.x - 32}" y="${p.y - 48}" width="64" height="15" rx="3" fill="#7f1d1d" stroke="#ef4444"/>
           <text x="${p.x}" y="${p.y - 37}" text-anchor="middle" font-size="9" font-family="ui-monospace, monospace" fill="#fecaca">LINK DOWN</text>`
        : "";

      return `
        <g>
          ${pulse}
          <circle cx="${p.x}" cy="${p.y}" r="30" fill="${fill}" stroke="${ringColor}" stroke-width="3"
                  ${!n.linkUp ? 'stroke-dasharray="5 3"' : ""} />
          <text x="${p.x}" y="${p.y - 4}" text-anchor="middle" font-size="12" font-weight="700" fill="#f8fafc">${n.config.label}</text>
          <text x="${p.x}" y="${p.y + 11}" text-anchor="middle" font-size="9.5" font-weight="600" font-family="ui-monospace, monospace" fill="${ringColor}">${roleText}</text>
          ${linkWarn}
          <rect x="${p.x - 54}" y="${p.y + 34}" width="108" height="32" rx="5" fill="#0d131b" stroke="#243041"/>
          <text x="${p.x}" y="${p.y + 47}" text-anchor="middle" font-size="10" font-family="ui-monospace, monospace" fill="#94a3b8">${n.config.ip}</text>
          <text x="${p.x}" y="${p.y + 60}" text-anchor="middle" font-size="10" font-family="ui-monospace, monospace" fill="#e2e8f0">T:${term} C:${ci} A:${ai}</text>
        </g>
      `;
    });

    this.#svgHost.innerHTML = `
      <svg viewBox="0 0 640 340" class="topo-svg" preserveAspectRatio="xMidYMid meet">
        ${linksSvg.join("")}
        ${nodesSvg.join("")}
      </svg>
    `;
  }

  renderCards(): void {
    if (this.#nodes.length === 0) {
      this.#cardsHost.innerHTML = "";
      return;
    }

    this.#cardsHost.innerHTML = this.#nodes
      .map((n) => {
        const id = n.config.nodeId;
        const st = n.raftStatus;
        const tcp = n.kernelTcp;
        const role = st?.role ?? "Unknown";

        let badgeClass = "badge-muted";
        let badgeText: string = n.lifecycle.toUpperCase();
        if (n.lifecycle === "running") {
          if (!n.raftRunning) {
            badgeClass = "badge-err";
            badgeText = "RAFT KILLED";
          } else if (role === "Leader") {
            badgeClass = "badge-ok";
            badgeText = "LEADER";
          } else if (role === "Candidate") {
            badgeClass = "badge-warn";
            badgeText = "CANDIDATE";
          } else {
            badgeClass = "badge-info";
            badgeText = "FOLLOWER";
          }
        } else if (n.lifecycle === "dead") {
          badgeClass = "badge-err";
          badgeText = "POWER OFF";
        } else if (n.lifecycle === "booting") {
          badgeClass = "badge-warn";
          badgeText = "BOOTING";
        }

        const isRunning = n.lifecycle === "running";
        const isDead = n.lifecycle === "dead" || n.lifecycle === "error";

        return `
          <div class="node-card" data-node-id="${id}">
            <div class="node-card-head">
              <div>
                <strong>${n.config.label}</strong>
                <span class="mono muted">${n.config.ip}</span>
              </div>
              <span class="badge ${badgeClass}">${badgeText}</span>
            </div>

            <div class="node-metrics mono">
              <div>Term: <strong>${st?.term ?? "-"}</strong></div>
              <div>Commit/Applied: <strong>${st?.commitIndex ?? "-"}/${st?.appliedIndex ?? "-"}</strong></div>
              <div>PID: <strong>${n.raftPid ?? "-"}</strong></div>
              <div>RetransSegs: <strong class="${(tcp?.retransSegs ?? 0) > 0 ? "text-err" : ""}">${tcp?.retransSegs ?? "-"}</strong></div>
              <div>ESTAB: <strong>${tcp?.states.ESTABLISHED ?? "-"}</strong></div>
              <div>Link: <strong class="${n.linkUp ? "text-ok" : "text-err"}">${n.linkUp ? "UP" : "SEVERED"}</strong></div>
            </div>

            <div class="node-actions">
              <button class="btn btn-sm ${n.linkUp ? "" : "btn-warn"}" data-act="toggle-link" data-node="${id}" ${!isRunning ? "disabled" : ""}>
                ${n.linkUp ? "拔网线" : "插网线"}
              </button>
              ${
                n.raftRunning
                  ? `<button class="btn btn-sm btn-danger" data-act="kill-raft" data-node="${id}" ${!isRunning ? "disabled" : ""}>kill -9</button>`
                  : `<button class="btn btn-sm btn-ok" data-act="start-raft" data-node="${id}" ${!isRunning ? "disabled" : ""}>拉起进程</button>`
              }
              ${
                isDead
                  ? `<button class="btn btn-sm btn-primary" data-act="reboot-node" data-node="${id}">重启 VM</button>`
                  : `<button class="btn btn-sm btn-danger" data-act="power-cut" data-node="${id}" ${n.lifecycle === "stopped" ? "disabled" : ""}>硬断电</button>`
              }
              <button class="btn btn-sm" data-act="open-term" data-node="${id}" ${!isRunning ? "disabled" : ""}>终端</button>
            </div>
          </div>
        `;
      })
      .join("");

    this.#cardsHost.querySelectorAll<HTMLButtonElement>("button[data-act]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const act = btn.dataset.act;
        const nodeId = btn.dataset.node!;
        const node = this.#nodes.find((x) => x.config.nodeId === nodeId);
        if (!node) return;
        if (act === "toggle-link") this.#actions.onToggleLink(nodeId, !node.linkUp);
        else if (act === "kill-raft") this.#actions.onKillRaft(nodeId);
        else if (act === "start-raft") this.#actions.onStartRaft(nodeId);
        else if (act === "power-cut") this.#actions.onPowerCut(nodeId);
        else if (act === "reboot-node") this.#actions.onRebootNode(nodeId);
        else if (act === "open-term") this.#actions.onOpenTerminal(nodeId);
      });
    });
  }
}
