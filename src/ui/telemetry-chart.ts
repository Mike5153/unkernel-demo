import type {
  NodeRuntimeState,
  SwitchTelemetrySnapshot,
  TimelineEvent,
} from "../cluster/types";

interface KernelPoint {
  ts: number;
  byNode: Record<string, number>;
}

interface SwitchPoint {
  ts: number;
  retransPerSec: number;
  dupAcksPerSec: number;
  avgRttMs: number;
  pps: number;
}

const NODE_COLORS = ["#22c55e", "#3b82f6", "#f59e0b", "#ec4899", "#a855f7"];

export class TelemetryView {
  readonly #root: HTMLElement;
  #kernelHistory: KernelPoint[] = [];
  #switchHistory: SwitchPoint[] = [];
  #nodes: NodeRuntimeState[] = [];
  #events: TimelineEvent[] = [];
  #filter: TimelineEvent["category"] | "all" = "all";
  #lastKernelSampleTs = 0;
  #lastSwitchSampleTs = 0;

  constructor(root: HTMLElement) {
    this.#root = root;
    this.#renderSkeleton();
  }

  #renderSkeleton(): void {
    this.#root.innerHTML = `
      <section class="panel telemetry-charts-panel">
        <div class="panel-header">
          <h2>Linux 内核 TCP & 虚拟交换机实时遥测</h2>
          <span id="tel-switch-summary" class="mono muted">Switch: 0 pps | Retrans: 0 | DupACK: 0</span>
        </div>

        <div class="charts-grid">
          <div class="chart-box">
            <div class="chart-title">Linux 内核 <code>/proc/net/snmp</code> Tcp.RetransSegs (累计重传段)</div>
            <canvas id="chart-retrans"></canvas>
            <div id="chart-retrans-legend" class="chart-legend mono"></div>
          </div>
          <div class="chart-box">
            <div class="chart-title">L2 交换机嗅探: Retrans/s · DupACK/s · RTT(ms)</div>
            <canvas id="chart-switch"></canvas>
            <div class="chart-legend mono">
              <span><i style="background:#ef4444"></i>Retrans/s</span>
              <span><i style="background:#f59e0b"></i>DupACK/s</span>
              <span><i style="background:#38bdf8"></i>Avg RTT (ms)</span>
            </div>
          </div>
        </div>

        <div id="tcp-states-bar" class="tcp-states-bar mono"></div>
      </section>

      <section class="panel timeline-panel">
        <div class="panel-header">
          <h2>毫秒级统一事件时间线 (Chaos → TCP → Raft)</h2>
          <div class="timeline-filters">
            <button class="chip is-active" data-filter="all">全部</button>
            <button class="chip" data-filter="chaos">Chaos</button>
            <button class="chip" data-filter="tcp">TCP</button>
            <button class="chip" data-filter="raft">Raft</button>
            <button class="chip" data-filter="lifecycle">Lifecycle</button>
            <button class="chip" data-filter="workload">Workload</button>
          </div>
        </div>
        <div id="timeline-list" class="timeline-list mono"></div>
      </section>
    `;

    this.#root.querySelectorAll<HTMLButtonElement>("button[data-filter]").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.#filter = btn.dataset.filter as any;
        this.#root.querySelectorAll("button[data-filter]").forEach((b) =>
          b.classList.toggle("is-active", b === btn)
        );
        this.#renderTimeline();
      });
    });
  }

  reset(): void {
    this.#kernelHistory = [];
    this.#switchHistory = [];
    this.#events = [];
    this.#lastKernelSampleTs = 0;
    this.#lastSwitchSampleTs = 0;
    this.#drawKernelChart();
    this.#drawSwitchChart();
    this.#renderTimeline();
  }

  updateNodes(nodes: NodeRuntimeState[]): void {
    this.#nodes = nodes;
    const now = performance.now();
    if (now - this.#lastKernelSampleTs >= 450 && nodes.some((n) => n.kernelTcp)) {
      this.#lastKernelSampleTs = now;
      const byNode: Record<string, number> = {};
      for (const n of nodes) {
        if (n.kernelTcp) byNode[n.config.nodeId] = n.kernelTcp.retransSegs;
      }
      this.#kernelHistory.push({ ts: now, byNode });
      if (this.#kernelHistory.length > 90) this.#kernelHistory.shift();
      this.#drawKernelChart();
    }
    this.#renderTcpStates();
  }

  updateSwitchTelemetry(snap: SwitchTelemetrySnapshot): void {
    const sumEl = this.#root.querySelector("#tel-switch-summary");
    if (sumEl) {
      sumEl.textContent =
        `PPS: ${snap.totalPps.toFixed(0)} | RX: ${snap.totalRxFrames} | Drop: ${snap.totalDroppedFrames} | ` +
        `Retrans: ${snap.totalRetransmits} (${snap.retransmitsPerSec.toFixed(1)}/s) | ` +
        `DupACK: ${snap.totalDupAcks} | RTT: ${snap.avgRttMs !== null ? snap.avgRttMs.toFixed(1) + "ms" : "-"}`;
    }

    const now = performance.now();
    if (now - this.#lastSwitchSampleTs >= 250) {
      this.#lastSwitchSampleTs = now;
      this.#switchHistory.push({
        ts: now,
        retransPerSec: snap.retransmitsPerSec,
        dupAcksPerSec: snap.dupAcksPerSec,
        avgRttMs: snap.avgRttMs ?? 0,
        pps: snap.totalPps,
      });
      if (this.#switchHistory.length > 100) this.#switchHistory.shift();
      this.#drawSwitchChart();
    }
  }

  pushEvent(ev: TimelineEvent): void {
    this.#events.unshift(ev);
    if (this.#events.length > 250) this.#events.length = 250;
    this.#renderTimeline();
  }

  #renderTcpStates(): void {
    const host = this.#root.querySelector("#tcp-states-bar");
    if (!host) return;
    if (this.#nodes.length === 0) {
      host.innerHTML = "";
      return;
    }
    host.innerHTML = this.#nodes
      .map((n) => {
        const s = n.kernelTcp?.states;
        if (!s) {
          return `<div class="tcp-state-chip"><span>${n.config.label}</span> <span class="muted">N/A</span></div>`;
        }
        return `
          <div class="tcp-state-chip">
            <strong>${n.config.label}</strong>
            <span class="text-ok">ESTAB:${s.ESTABLISHED}</span>
            <span class="${s.SYN_SENT > 0 ? "text-warn" : "muted"}">SYN_SENT:${s.SYN_SENT}</span>
            <span class="muted">TIME_WAIT:${s.TIME_WAIT}</span>
            <span class="muted">LISTEN:${s.LISTEN}</span>
          </div>
        `;
      })
      .join("");
  }

  #renderTimeline(): void {
    const list = this.#root.querySelector("#timeline-list");
    if (!list) return;
    const filtered =
      this.#filter === "all"
        ? this.#events
        : this.#events.filter((e) => e.category === this.#filter);

    if (filtered.length === 0) {
      list.innerHTML = `<div class="muted" style="padding:8px;">暂无事件记录...</div>`;
      return;
    }

    list.innerHTML = filtered
      .slice(0, 120)
      .map(
        (ev) => `
          <div class="tl-row tl-${ev.category}">
            <span class="tl-time">${ev.timeLabel}</span>
            <span class="tl-cat">[${ev.category.toUpperCase()}]</span>
            <span class="tl-msg">${this.#escapeHtml(ev.message)}</span>
          </div>
        `
      )
      .join("");
  }

  #escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  #prepCanvas(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(240, Math.floor(rect.width));
    const h = Math.max(120, Math.floor(rect.height));
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return ctx;
  }

  #drawGrid(ctx: CanvasRenderingContext2D, w: number, h: number, maxVal: number, unit: string): void {
    const padL = 38;
    const padR = 8;
    const padT = 10;
    const padB = 16;
    ctx.strokeStyle = "#1e293b";
    ctx.lineWidth = 1;
    ctx.fillStyle = "#64748b";
    ctx.font = "10px ui-monospace, monospace";
    for (let i = 0; i <= 3; i++) {
      const y = padT + ((h - padT - padB) * i) / 3;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.stroke();
      const val = Math.round(maxVal * (1 - i / 3));
      ctx.fillText(`${val}${unit}`, 4, y + 3);
    }
  }

  #drawKernelChart(): void {
    const canvas = this.#root.querySelector<HTMLCanvasElement>("#chart-retrans");
    const legend = this.#root.querySelector("#chart-retrans-legend");
    if (!canvas) return;
    const ctx = this.#prepCanvas(canvas);
    if (!ctx) return;

    const w = canvas.clientWidth || 320;
    const h = canvas.clientHeight || 130;

    let maxVal = 5;
    for (const pt of this.#kernelHistory) {
      for (const v of Object.values(pt.byNode)) {
        if (v > maxVal) maxVal = v;
      }
    }
    this.#drawGrid(ctx, w, h, maxVal, "");

    const padL = 38;
    const padR = 8;
    const padT = 10;
    const padB = 16;
    const plotW = Math.max(10, w - padL - padR);
    const plotH = Math.max(10, h - padT - padB);

    this.#nodes.forEach((n, idx) => {
      const color = NODE_COLORS[idx % NODE_COLORS.length]!;
      if (this.#kernelHistory.length < 2) return;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      let started = false;
      this.#kernelHistory.forEach((pt, i) => {
        const val = pt.byNode[n.config.nodeId];
        if (val === undefined) return;
        const x = padL + (i / (this.#kernelHistory.length - 1)) * plotW;
        const y = padT + plotH - (val / maxVal) * plotH;
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      });
      ctx.stroke();
    });

    if (legend) {
      legend.innerHTML = this.#nodes
        .map((n, idx) => {
          const color = NODE_COLORS[idx % NODE_COLORS.length]!;
          const v = n.kernelTcp?.retransSegs ?? 0;
          return `<span><i style="background:${color}"></i>${n.config.label}: ${v}</span>`;
        })
        .join("");
    }
  }

  #drawSwitchChart(): void {
    const canvas = this.#root.querySelector<HTMLCanvasElement>("#chart-switch");
    if (!canvas) return;
    const ctx = this.#prepCanvas(canvas);
    if (!ctx) return;

    const w = canvas.clientWidth || 320;
    const h = canvas.clientHeight || 130;

    let maxRate = 5;
    let maxRtt = 50;
    for (const pt of this.#switchHistory) {
      if (pt.retransPerSec > maxRate) maxRate = pt.retransPerSec;
      if (pt.dupAcksPerSec > maxRate) maxRate = pt.dupAcksPerSec;
      if (pt.avgRttMs > maxRtt) maxRtt = pt.avgRttMs;
    }
    this.#drawGrid(ctx, w, h, maxRate, "/s");

    if (this.#switchHistory.length < 2) return;
    const padL = 38;
    const padR = 8;
    const padT = 10;
    const padB = 16;
    const plotW = Math.max(10, w - padL - padR);
    const plotH = Math.max(10, h - padT - padB);

    const drawSeries = (pick: (p: SwitchPoint) => number, max: number, color: string) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      this.#switchHistory.forEach((pt, i) => {
        const x = padL + (i / (this.#switchHistory.length - 1)) * plotW;
        const y = padT + plotH - Math.min(1, pick(pt) / max) * plotH;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    };

    drawSeries((p) => p.avgRttMs, maxRtt, "#38bdf8");
    drawSeries((p) => p.dupAcksPerSec, maxRate, "#f59e0b");
    drawSeries((p) => p.retransPerSec, maxRate, "#ef4444");
  }
}
