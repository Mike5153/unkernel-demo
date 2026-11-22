import type { ClusterManager } from "../cluster/cluster-manager";
import type {
  NodeId,
  NodeRuntimeState,
  WorkloadStats,
} from "../cluster/types";

export class ChaosPanel {
  readonly #cluster: ClusterManager;
  readonly #root: HTMLElement;

  #nodes: NodeRuntimeState[] = [];
  #srcNode: NodeId = "node-1";
  #dstNode: NodeId = "node-2";
  #bidirectional = true;
  #workloadStats: WorkloadStats;

  constructor(opts: { root: HTMLElement; cluster: ClusterManager }) {
    this.#root = opts.root;
    this.#cluster = opts.cluster;
    this.#workloadStats = opts.cluster.getWorkloadStats();
    this.#renderSkeleton();
  }

  updateNodes(nodes: NodeRuntimeState[]): void {
    this.#nodes = nodes;
    this.#syncSelectors();
    this.#renderRulesList();
  }

  updateWorkload(stats: WorkloadStats): void {
    this.#workloadStats = stats;
    this.#renderWorkload();
  }

  #renderSkeleton(): void {
    this.#root.innerHTML = `
      <section class="panel">
        <div class="panel-header">
          <h2>链路混沌注入器 (Virtual L2 Switch)</h2>
          <button id="chaos-heal-all" class="btn btn-sm">Heal All</button>
        </div>

        <div class="chaos-select-row">
          <label>源节点
            <select id="chaos-src"></select>
          </label>
          <span class="arrow-sep">→</span>
          <label>目标节点
            <select id="chaos-dst"></select>
          </label>
          <label class="inline-check">
            <input id="chaos-bidir" type="checkbox" checked /> 双向同步
          </label>
        </div>

        <div class="slider-group">
          <div class="slider-head">
            <span>延迟 (Delay): <strong id="chaos-delay-val">0 ms</strong></span>
            <div class="preset-row">
              <button class="chip" data-delay="0">0ms</button>
              <button class="chip" data-delay="50">50ms</button>
              <button class="chip" data-delay="300">300ms</button>
              <button class="chip" data-delay="1200">1200ms</button>
            </div>
          </div>
          <input id="chaos-delay" type="range" min="0" max="2000" step="10" value="0" />
        </div>

        <div class="slider-group">
          <div class="slider-head">
            <span>抖动 (Jitter): <strong id="chaos-jitter-val">0 ms</strong></span>
          </div>
          <input id="chaos-jitter" type="range" min="0" max="300" step="5" value="0" />
        </div>

        <div class="slider-group">
          <div class="slider-head">
            <span>丢包率 (Loss): <strong id="chaos-drop-val">0%</strong></span>
            <div class="preset-row">
              <button class="chip" data-drop="0">0%</button>
              <button class="chip" data-drop="5">5%</button>
              <button class="chip" data-drop="20">20%</button>
              <button class="chip" data-drop="50">50%</button>
            </div>
          </div>
          <input id="chaos-drop" type="range" min="0" max="100" step="1" value="0" />
        </div>

        <div class="chaos-toggles">
          <label class="inline-check">
            <input id="chaos-severed" type="checkbox" /> 物理断线 (severed)
          </label>
          <label class="inline-check">
            <input id="chaos-reorder" type="checkbox" /> 允许抖动乱序 (allowReorder)
          </label>
        </div>

        <div id="chaos-rules-list" class="rules-list"></div>
      </section>

      <section class="panel">
        <div class="panel-header">
          <h2>一键混沌实验剧本 (Chaos Scenarios)</h2>
        </div>
        <div class="scenario-grid">
          <button class="btn btn-sm" id="exp-delay">1. 高延迟 (Leader→F1 300ms)</button>
          <button class="btn btn-sm" id="exp-loss">2. 20% 丢包 (观察 TCP 重传)</button>
          <button class="btn btn-sm btn-warn" id="exp-unplug-leader">3. 拔 Leader 网线 (少数派脑裂)</button>
          <button class="btn btn-sm" id="exp-split-brain">脑裂 ({Node A} vs 多数派)</button>
          <button class="btn btn-sm btn-danger" id="exp-sigkill-leader">4a. SIGKILL Leader (TCP RST)</button>
          <button class="btn btn-sm btn-danger" id="exp-powercut-leader">4b. 断电 Leader (RTO 退避)</button>
        </div>
      </section>

      <section class="panel">
        <div class="panel-header">
          <h2>Raft KV 写入压测 (Workload)</h2>
          <button id="wl-toggle" class="btn btn-sm btn-primary">开始压测 (200ms)</button>
        </div>
        <div class="wl-controls">
          <label>目标节点
            <select id="wl-target">
              <option value="auto">自动跟踪 Leader</option>
            </select>
          </label>
          <form id="wl-manual-form" class="input-row">
            <input id="wl-key" type="text" value="demo" placeholder="key" />
            <input id="wl-val" type="text" value="hello" placeholder="val" />
            <button class="btn btn-sm" type="submit">PUT</button>
          </form>
        </div>
        <div id="wl-summary" class="wl-summary mono"></div>
        <div id="wl-recent" class="wl-recent mono"></div>
      </section>
    `;

    this.#bindEvents();
    this.#renderWorkload();
  }

  #bindEvents(): void {
    const srcEl = this.#root.querySelector<HTMLSelectElement>("#chaos-src")!;
    const dstEl = this.#root.querySelector<HTMLSelectElement>("#chaos-dst")!;
    const bidirEl = this.#root.querySelector<HTMLInputElement>("#chaos-bidir")!;
    const delayEl = this.#root.querySelector<HTMLInputElement>("#chaos-delay")!;
    const jitterEl = this.#root.querySelector<HTMLInputElement>("#chaos-jitter")!;
    const dropEl = this.#root.querySelector<HTMLInputElement>("#chaos-drop")!;
    const severedEl = this.#root.querySelector<HTMLInputElement>("#chaos-severed")!;
    const reorderEl = this.#root.querySelector<HTMLInputElement>("#chaos-reorder")!;

    const applyFromControls = () => {
      if (!this.#srcNode || !this.#dstNode || this.#srcNode === this.#dstNode) return;
      const delayMs = Number(delayEl.value);
      const jitterMs = Number(jitterEl.value);
      const dropRate = Number(dropEl.value) / 100;
      const severed = severedEl.checked;
      const allowReorder = reorderEl.checked;
      this.#updateSliderLabels();
      this.#cluster.setLinkChaos(
        this.#srcNode,
        this.#dstNode,
        { delayMs, jitterMs, dropRate, severed, allowReorder },
        this.#bidirectional
      );
      this.#renderRulesList();
    };

    srcEl.addEventListener("change", () => {
      this.#srcNode = srcEl.value;
      this.#loadControlsFromCurrentRule();
    });
    dstEl.addEventListener("change", () => {
      this.#dstNode = dstEl.value;
      this.#loadControlsFromCurrentRule();
    });
    bidirEl.addEventListener("change", () => {
      this.#bidirectional = bidirEl.checked;
    });

    delayEl.addEventListener("input", () => this.#updateSliderLabels());
    jitterEl.addEventListener("input", () => this.#updateSliderLabels());
    dropEl.addEventListener("input", () => this.#updateSliderLabels());

    delayEl.addEventListener("change", applyFromControls);
    jitterEl.addEventListener("change", applyFromControls);
    dropEl.addEventListener("change", applyFromControls);
    severedEl.addEventListener("change", applyFromControls);
    reorderEl.addEventListener("change", applyFromControls);

    this.#root.querySelectorAll<HTMLButtonElement>("button[data-delay]").forEach((btn) => {
      btn.addEventListener("click", () => {
        delayEl.value = btn.dataset.delay!;
        applyFromControls();
      });
    });

    this.#root.querySelectorAll<HTMLButtonElement>("button[data-drop]").forEach((btn) => {
      btn.addEventListener("click", () => {
        dropEl.value = btn.dataset.drop!;
        applyFromControls();
      });
    });

    this.#root.querySelector("#chaos-heal-all")!.addEventListener("click", () => {
      this.#cluster.healAllChaos();
      this.#loadControlsFromCurrentRule();
      this.#renderRulesList();
    });

    // Scenarios
    this.#root.querySelector("#exp-delay")!.addEventListener("click", () => {
      const { leader, follower } = this.#pickLeaderAndFollower();
      this.#srcNode = leader;
      this.#dstNode = follower;
      this.#bidirectional = false;
      bidirEl.checked = false;
      this.#cluster.setLinkChaos(leader, follower, { delayMs: 300, jitterMs: 40, dropRate: 0, severed: false }, false);
      this.#syncSelectors();
      this.#renderRulesList();
    });

    this.#root.querySelector("#exp-loss")!.addEventListener("click", () => {
      const { leader, follower } = this.#pickLeaderAndFollower();
      this.#srcNode = leader;
      this.#dstNode = follower;
      this.#bidirectional = true;
      bidirEl.checked = true;
      this.#cluster.setLinkChaos(leader, follower, { delayMs: 20, jitterMs: 5, dropRate: 0.2, severed: false }, true);
      this.#syncSelectors();
      this.#renderRulesList();
    });

    this.#root.querySelector("#exp-unplug-leader")!.addEventListener("click", () => {
      const { leader } = this.#pickLeaderAndFollower();
      this.#cluster.setNodeLink(leader, false);
    });

    this.#root.querySelector("#exp-split-brain")!.addEventListener("click", () => {
      const first = this.#nodes[0]?.config.nodeId ?? "node-1";
      this.#cluster.applySplitBrain([first]);
      this.#renderRulesList();
    });

    this.#root.querySelector("#exp-sigkill-leader")!.addEventListener("click", () => {
      const { leader } = this.#pickLeaderAndFollower();
      void this.#cluster.killRaftProcess(leader);
    });

    this.#root.querySelector("#exp-powercut-leader")!.addEventListener("click", () => {
      const { leader } = this.#pickLeaderAndFollower();
      this.#cluster.powerCutNode(leader);
    });

    // Workload
    const wlToggle = this.#root.querySelector<HTMLButtonElement>("#wl-toggle")!;
    const wlTarget = this.#root.querySelector<HTMLSelectElement>("#wl-target")!;
    const wlForm = this.#root.querySelector<HTMLFormElement>("#wl-manual-form")!;
    const wlKey = this.#root.querySelector<HTMLInputElement>("#wl-key")!;
    const wlVal = this.#root.querySelector<HTMLInputElement>("#wl-val")!;

    wlToggle.addEventListener("click", () => {
      if (this.#cluster.getWorkloadStats().running) {
        this.#cluster.stopWorkload();
      } else {
        this.#cluster.startWorkload(200);
      }
    });

    wlTarget.addEventListener("change", () => {
      this.#cluster.setWorkloadTarget(wlTarget.value as NodeId | "auto");
    });

    wlForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const k = wlKey.value.trim();
      const v = wlVal.value.trim();
      if (!k) return;
      void this.#cluster.putKV(k, v, wlTarget.value as NodeId | "auto");
    });
  }

  #pickLeaderAndFollower(): { leader: NodeId; follower: NodeId } {
    const leader =
      this.#cluster.getLeaderNodeId() ??
      this.#nodes.find((n) => n.lifecycle === "running")?.config.nodeId ??
      "node-1";
    const follower =
      this.#nodes.find((n) => n.config.nodeId !== leader && n.lifecycle === "running")?.config.nodeId ??
      this.#nodes.find((n) => n.config.nodeId !== leader)?.config.nodeId ??
      "node-2";
    return { leader, follower };
  }

  #syncSelectors(): void {
    const srcEl = this.#root.querySelector<HTMLSelectElement>("#chaos-src")!;
    const dstEl = this.#root.querySelector<HTMLSelectElement>("#chaos-dst")!;
    const wlTarget = this.#root.querySelector<HTMLSelectElement>("#wl-target")!;

    const opts = this.#nodes
      .map((n) => `<option value="${n.config.nodeId}">${n.config.label} (${n.config.ip})</option>`)
      .join("");

    srcEl.innerHTML = opts;
    dstEl.innerHTML = opts;
    if (this.#nodes.some((n) => n.config.nodeId === this.#srcNode)) {
      srcEl.value = this.#srcNode;
    } else if (this.#nodes[0]) {
      this.#srcNode = this.#nodes[0].config.nodeId;
      srcEl.value = this.#srcNode;
    }
    if (this.#nodes.some((n) => n.config.nodeId === this.#dstNode)) {
      dstEl.value = this.#dstNode;
    } else if (this.#nodes[1]) {
      this.#dstNode = this.#nodes[1].config.nodeId;
      dstEl.value = this.#dstNode;
    }

    const prevTarget = wlTarget.value || "auto";
    wlTarget.innerHTML = `<option value="auto">自动跟踪 Leader</option>${opts}`;
    wlTarget.value = prevTarget;

    this.#loadControlsFromCurrentRule();
  }

  #loadControlsFromCurrentRule(): void {
    const rule = this.#cluster.vSwitch.getRule(this.#srcNode, this.#dstNode);
    this.#root.querySelector<HTMLInputElement>("#chaos-delay")!.value = String(rule.delayMs);
    this.#root.querySelector<HTMLInputElement>("#chaos-jitter")!.value = String(rule.jitterMs);
    this.#root.querySelector<HTMLInputElement>("#chaos-drop")!.value = String(Math.round(rule.dropRate * 100));
    this.#root.querySelector<HTMLInputElement>("#chaos-severed")!.checked = rule.severed;
    this.#root.querySelector<HTMLInputElement>("#chaos-reorder")!.checked = !!rule.allowReorder;
    this.#updateSliderLabels();
  }

  #updateSliderLabels(): void {
    const delay = this.#root.querySelector<HTMLInputElement>("#chaos-delay")!.value;
    const jitter = this.#root.querySelector<HTMLInputElement>("#chaos-jitter")!.value;
    const drop = this.#root.querySelector<HTMLInputElement>("#chaos-drop")!.value;
    this.#root.querySelector("#chaos-delay-val")!.textContent = `${delay} ms`;
    this.#root.querySelector("#chaos-jitter-val")!.textContent = `${jitter} ms`;
    this.#root.querySelector("#chaos-drop-val")!.textContent = `${drop}%`;
  }

  #renderRulesList(): void {
    const host = this.#root.querySelector("#chaos-rules-list")!;
    const rules = this.#cluster.vSwitch.getAllNonDefaultRules();
    if (rules.length === 0) {
      host.innerHTML = `<div class="muted">当前所有链路均无混沌规则（0ms / 0% loss）</div>`;
      return;
    }
    const labelOf = (id: NodeId) =>
      this.#nodes.find((n) => n.config.nodeId === id)?.config.label ?? id;

    host.innerHTML = rules
      .map(({ src, dst, rule }) => {
        const text = rule.severed
          ? "SEVERED"
          : `${rule.delayMs}ms (±${rule.jitterMs}ms) · ${Math.round(rule.dropRate * 100)}% loss`;
        return `
          <div class="rule-item mono">
            <span>${labelOf(src)} → ${labelOf(dst)}: <strong>${text}</strong></span>
            <button class="btn btn-sm" data-clear-src="${src}" data-clear-dst="${dst}">清除</button>
          </div>
        `;
      })
      .join("");

    host.querySelectorAll<HTMLButtonElement>("button[data-clear-src]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.#cluster.setLinkChaos(
          btn.dataset.clearSrc!,
          btn.dataset.clearDst!,
          { delayMs: 0, jitterMs: 0, dropRate: 0, severed: false, allowReorder: false },
          false
        );
        this.#loadControlsFromCurrentRule();
        this.#renderRulesList();
      });
    });
  }

  #renderWorkload(): void {
    const st = this.#workloadStats;
    const toggleBtn = this.#root.querySelector<HTMLButtonElement>("#wl-toggle");
    if (toggleBtn) {
      toggleBtn.textContent = st.running ? "停止压测" : "开始压测 (200ms)";
      toggleBtn.className = `btn btn-sm ${st.running ? "btn-danger" : "btn-primary"}`;
    }

    const summaryEl = this.#root.querySelector("#wl-summary");
    if (summaryEl) {
      summaryEl.innerHTML = `
        <span>Total: <strong>${st.total}</strong></span>
        <span class="text-ok">OK: <strong>${st.succeeded}</strong></span>
        <span class="${st.failed > 0 ? "text-err" : ""}">Fail: <strong>${st.failed}</strong></span>
        <span>Last: <strong>${st.lastLatencyMs ?? "-"} ms</strong></span>
        <span>P95: <strong>${st.p95LatencyMs ?? "-"} ms</strong></span>
      `;
    }

    const recentEl = this.#root.querySelector("#wl-recent");
    if (recentEl) {
      recentEl.innerHTML = st.recent
        .slice(0, 6)
        .map((s) => {
          const badge = s.ok
            ? `<span class="text-ok">OK idx=${s.index} T${s.term}</span>`
            : `<span class="text-err">ERR ${s.error ?? s.status}</span>`;
          return `<div class="wl-row">#${s.seq} [${s.targetNodeId}] ${s.key}=${s.val} → ${badge} (${s.latencyMs}ms)</div>`;
        })
        .join("");
    }
  }
}
