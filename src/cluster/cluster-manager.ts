import { bundledKernelUrl, loadKernelModule, type BootProgress } from "unkernel";
import { VirtualL2Switch } from "./switch";
import type {
  KernelTcpSnapshot,
  LinkChaosRule,
  NodeConfig,
  NodeId,
  NodeRuntimeState,
  RaftRole,
  RaftStatus,
  SwitchTelemetrySnapshot,
  TcpSniffEvent,
  TimelineEvent,
  WorkloadSample,
  WorkloadStats,
} from "./types";

const NODE_LABELS = ["Node A", "Node B", "Node C", "Node D", "Node E"];

export function buildClusterConfigs(count: number): NodeConfig[] {
  const clamped = Math.max(3, Math.min(5, count));
  const out: NodeConfig[] = [];
  for (let i = 1; i <= clamped; i++) {
    const hex = i.toString(16).padStart(2, "0");
    out.push({
      nodeId: `node-${i}`,
      label: NODE_LABELS[i - 1] ?? `Node ${i}`,
      macHex: `52:54:00:00:00:${hex}`,
      ip: `10.10.0.${10 + i}`,
      raftPort: 2380,
      httpPort: 8080,
    });
  }
  return out;
}

export interface ProxyPty {
  output: ReadableStream<Uint8Array>;
  ended: Promise<{ type: string; code?: number }>;
  write: (data: string | Uint8Array) => Promise<void>;
  resize: (cols: number, rows: number) => void;
  close: () => Promise<void>;
}

export interface WorkerVmProxy {
  nodeId: NodeId;
  write: (data: string | Uint8Array) => void;
  resize: (cols: number, rows: number) => void;
  spawn: (
    file?: string,
    args?: readonly string[],
    opts?: { cols?: number; rows?: number; term?: string; detachable?: boolean }
  ) => Promise<ProxyPty>;
  exec: (file: string, args?: readonly string[]) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

interface PendingRpc {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PtyBridge {
  controller: ReadableStreamDefaultController<Uint8Array>;
  resolveEnd: (v: { type: string; code?: number }) => void;
  rejectEnd: (e: Error) => void;
}

interface ManagedNode {
  config: NodeConfig;
  worker: Worker | null;
  state: NodeRuntimeState;
  pendingRpcs: Map<number, PendingRpc>;
  ptys: Map<string, PtyBridge>;
  consoleHistory: string;
  consoleListeners: Set<(text: string) => void>;
  prevRole: RaftRole | null;
  prevTerm: number | null;
  polling: boolean;
}

export interface ClusterEvents {
  onNodesChanged?: (nodes: NodeRuntimeState[]) => void;
  onSwitchTelemetry?: (snapshot: SwitchTelemetrySnapshot) => void;
  onTimelineEvent?: (event: TimelineEvent) => void;
  onWorkloadChanged?: (stats: WorkloadStats) => void;
  onBootProgress?: (message: string) => void;
}

export class ClusterManager {
  readonly vSwitch = new VirtualL2Switch();
  #events: ClusterEvents;
  #nodes = new Map<NodeId, ManagedNode>();
  #configs: NodeConfig[] = [];
  #kernelModule: WebAssembly.Module | null = null;
  #raftBinary: Uint8Array | null = null;
  #startedAt = 0;
  #nextRpcId = 1;
  #nextPtySeq = 1;
  #nextEventId = 1;
  #timeline: TimelineEvent[] = [];
  #telemetryPollTimer: ReturnType<typeof setInterval> | null = null;

  #workloadTimer: ReturnType<typeof setInterval> | null = null;
  #workloadSeq = 0;
  #workloadTotal = 0;
  #workloadSucceeded = 0;
  #workloadFailed = 0;
  #workloadLatencies: number[] = [];
  #workloadRecent: WorkloadSample[] = [];
  #workloadTarget: NodeId | "auto" = "auto";
  #workloadInFlight = false;

  #lastRetransEventAt = new Map<string, number>();

  constructor(events: ClusterEvents = {}) {
    this.#events = events;
    this.vSwitch.setCallbacks({
      onTelemetry: (snap) => this.#events.onSwitchTelemetry?.(snap),
      onTcpEvent: (ev) => this.#handleSniffedTcpEvent(ev),
    });
  }

  setEvents(events: ClusterEvents): void {
    this.#events = events;
  }

  getNodeStates(): NodeRuntimeState[] {
    return [...this.#nodes.values()].map((m) => m.state);
  }

  getNodeState(nodeId: NodeId): NodeRuntimeState | undefined {
    return this.#nodes.get(nodeId)?.state;
  }

  getTimeline(): TimelineEvent[] {
    return this.#timeline;
  }

  getWorkloadStats(): WorkloadStats {
    const sorted = [...this.#workloadLatencies].sort((a, b) => a - b);
    const p95 =
      sorted.length > 0
        ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!
        : null;
    const last =
      this.#workloadRecent.length > 0
        ? this.#workloadRecent[this.#workloadRecent.length - 1]!.latencyMs
        : null;
    return {
      running: this.#workloadTimer !== null,
      total: this.#workloadTotal,
      succeeded: this.#workloadSucceeded,
      failed: this.#workloadFailed,
      lastLatencyMs: last,
      p95LatencyMs: p95,
      recent: this.#workloadRecent,
    };
  }

  getLeaderNodeId(): NodeId | null {
    let bestTerm = -1;
    let leaderId: NodeId | null = null;
    for (const m of this.#nodes.values()) {
      const st = m.state.raftStatus;
      if (m.state.lifecycle === "running" && st?.role === "Leader" && st.term >= bestTerm) {
        bestTerm = st.term;
        leaderId = m.config.nodeId;
      }
    }
    return leaderId;
  }

  clearTimeline(): void {
    this.#timeline = [];
  }

  #formatTimeOffset(): string {
    const elapsed = this.#startedAt ? Math.max(0, performance.now() - this.#startedAt) : 0;
    const totalSec = Math.floor(elapsed / 1000);
    const min = String(Math.floor(totalSec / 60)).padStart(2, "0");
    const sec = String(totalSec % 60).padStart(2, "0");
    const ms = String(Math.floor(elapsed % 1000)).padStart(3, "0");
    return `${min}:${sec}.${ms}`;
  }

  logEvent(category: TimelineEvent["category"], message: string, nodeId?: NodeId): void {
    const ev: TimelineEvent = {
      id: this.#nextEventId++,
      tsMs: performance.now(),
      timeLabel: this.#formatTimeOffset(),
      category,
      nodeId,
      message,
    };
    this.#timeline.unshift(ev);
    if (this.#timeline.length > 250) {
      this.#timeline.length = 250;
    }
    this.#events.onTimelineEvent?.(ev);
  }

  #handleSniffedTcpEvent(ev: TcpSniffEvent): void {
    const key = `${ev.kind}:${ev.srcIp}->${ev.dstIp}`;
    const prevAt = this.#lastRetransEventAt.get(key) ?? 0;
    if (ev.kind !== "rst" && ev.ts - prevAt < 650) return;
    this.#lastRetransEventAt.set(key, ev.ts);

    const srcName = this.#nodes.get(ev.srcNodeId ?? "")?.config.label ?? ev.srcIp;
    const dstName = this.#nodes.get(ev.dstNodeId ?? "")?.config.label ?? ev.dstIp;

    if (ev.kind === "retransmit") {
      this.logEvent(
        "tcp",
        `${srcName} (${ev.srcIp}) -> ${dstName} (${ev.dstIp}) 检测到 TCP Retransmit (seq=${ev.seq}, len=${ev.payloadLen})`,
        ev.srcNodeId
      );
    } else if (ev.kind === "dup_ack") {
      this.logEvent(
        "tcp",
        `${srcName} (${ev.srcIp}) -> ${dstName} (${ev.dstIp}) 3x DupACK Fast Retransmit 触发 (ack=${ev.ack})`,
        ev.srcNodeId
      );
    } else if (ev.kind === "rst") {
      this.logEvent(
        "tcp",
        `${srcName} (${ev.srcIp}:${ev.sport}) -> ${dstName} (${ev.dstIp}:${ev.dport}) 发送 TCP RST`,
        ev.srcNodeId
      );
    }
  }

  async #ensureAssets(): Promise<{ kernelModule: WebAssembly.Module; raftBinary: Uint8Array }> {
    if (!this.#kernelModule) {
      this.#events.onBootProgress?.("正在下载并预编译 unkernel.wasm（全集群共享编译一次）...");
      this.#kernelModule = await loadKernelModule(bundledKernelUrl, {
        what: "kernel",
        onProgress: (p: BootProgress) => {
          if (p.stage === "download") {
            const mb = (p.loaded / 1048576).toFixed(1);
            const total = p.total ? ` / ${(p.total / 1048576).toFixed(1)} MiB` : "";
            this.#events.onBootProgress?.(`下载内核 unkernel.wasm: ${mb}${total}`);
          } else if (p.stage === "compile") {
            this.#events.onBootProgress?.("正在编译共享 WebAssembly.Module...");
          }
        },
      });
    }

    if (!this.#raftBinary) {
      this.#events.onBootProgress?.("正在加载静态编译 aarch64 raft-node 二进制...");
      const resp = await fetch("/raft-node", { cache: "no-cache" });
      if (!resp.ok) {
        throw new Error(`Failed to fetch /raft-node (${resp.status}). Run src/guest-raft/build.ps1 first.`);
      }
      this.#raftBinary = new Uint8Array(await resp.arrayBuffer());
    }

    return { kernelModule: this.#kernelModule, raftBinary: this.#raftBinary };
  }

  async bootCluster(nodeCount = 3): Promise<void> {
    await this.stopCluster();

    this.#startedAt = performance.now();
    this.#timeline = [];
    this.#workloadSeq = 0;
    this.#workloadTotal = 0;
    this.#workloadSucceeded = 0;
    this.#workloadFailed = 0;
    this.#workloadLatencies = [];
    this.#workloadRecent = [];
    this.#events.onWorkloadChanged?.(this.getWorkloadStats());

    this.#configs = buildClusterConfigs(nodeCount);
    const { kernelModule, raftBinary } = await this.#ensureAssets();

    const peersSpec = this.#configs
      .map((c) => `${c.nodeId}=${c.ip}:${c.raftPort}`)
      .join(",");

    this.vSwitch.startTelemetry(100);
    this.logEvent("lifecycle", `启动 ${this.#configs.length} 节点 Raft 集群 (共享 WebAssembly.Module)`);

    for (const cfg of this.#configs) {
      const managed: ManagedNode = {
        config: cfg,
        worker: null,
        state: {
          config: cfg,
          lifecycle: "booting",
          linkUp: true,
          raftRunning: false,
          raftPid: null,
          raftStatus: null,
          kernelTcp: null,
          bootStage: "starting worker...",
        },
        pendingRpcs: new Map(),
        ptys: new Map(),
        consoleHistory: "",
        consoleListeners: new Set(),
        prevRole: null,
        prevTerm: null,
        polling: false,
      };
      this.#nodes.set(cfg.nodeId, managed);
    }
    this.#emitNodes();

    await Promise.all(
      this.#configs.map((cfg) => this.#bootSingleWorker(cfg.nodeId, kernelModule, raftBinary, peersSpec))
    );

    this.#startTelemetryPolling();
  }

  async #bootSingleWorker(
    nodeId: NodeId,
    kernelModule: WebAssembly.Module,
    raftBinary: Uint8Array,
    peersSpec: string
  ): Promise<void> {
    const managed = this.#nodes.get(nodeId);
    if (!managed) return;

    const { config } = managed;
    managed.state.lifecycle = "booting";
    managed.state.bootStage = "booting Linux...";
    managed.state.error = undefined;
    managed.state.raftRunning = false;
    managed.state.raftPid = null;
    managed.state.raftStatus = null;
    managed.prevRole = null;
    managed.prevTerm = null;
    this.#emitNodes();

    const { port1: switchPort, port2: workerPort } = new MessageChannel();
    this.vSwitch.attachPort({
      nodeId: config.nodeId,
      macHex: config.macHex,
      ip: config.ip,
      port: switchPort,
      linkUp: managed.state.linkUp,
    });

    const worker = new Worker(new URL("./node-worker.ts", import.meta.url), {
      type: "module",
    });
    managed.worker = worker;

    const readyPromise = new Promise<void>((resolve) => {
      const onReadyOrFail = (ev: MessageEvent<any>) => {
        const msg = ev.data;
        if (!msg) return;
        if (msg.type === "ready" || msg.type === "boot_error") {
          resolve();
        }
      };
      worker.addEventListener("message", onReadyOrFail, { once: false });
    });

    worker.onmessage = (ev: MessageEvent<any>) => {
      this.#onWorkerMessage(nodeId, ev.data);
    };
    worker.onerror = (ev) => {
      managed.state.lifecycle = "error";
      managed.state.error = ev.message || "Worker error";
      this.logEvent("lifecycle", `${config.label} Worker 异常: ${managed.state.error}`, nodeId);
      this.#emitNodes();
    };

    const binaryCopy = raftBinary.slice();
    worker.postMessage(
      {
        type: "boot",
        nodeId: config.nodeId,
        macHex: config.macHex,
        expectedIp: config.ip,
        kernelModule,
        netPort: workerPort,
        memoryMiB: 256,
        memoryFallbackMiB: [256, 192, 128],
        raftBinary: binaryCopy,
        peersSpec,
      },
      [workerPort, binaryCopy.buffer]
    );

    await readyPromise;
  }

  #onWorkerMessage(nodeId: NodeId, msg: any): void {
    const managed = this.#nodes.get(nodeId);
    if (!managed || !msg) return;

    switch (msg.type) {
      case "boot_progress": {
        const p = msg.progress as BootProgress;
        managed.state.bootStage = `kernel: ${p.stage}`;
        this.#emitNodes();
        break;
      }
      case "ready": {
        managed.state.lifecycle = "running";
        managed.state.bootStage = "ready";
        managed.state.raftPid = msg.raftPid ?? null;
        managed.state.raftRunning = !!msg.raftPid;
        this.logEvent(
          "lifecycle",
          `${managed.config.label} (${msg.ip}) 启动完成，raft-node PID=${msg.raftPid ?? "?"}`,
          nodeId
        );
        this.#emitNodes();
        break;
      }
      case "boot_error": {
        managed.state.lifecycle = "error";
        managed.state.error = msg.error;
        this.logEvent("lifecycle", `${managed.config.label} 启动失败: ${msg.error}`, nodeId);
        this.#emitNodes();
        break;
      }
      case "vm_exited": {
        if (managed.state.lifecycle !== "dead") {
          managed.state.lifecycle = "dead";
          managed.state.raftRunning = false;
          managed.state.raftPid = null;
          this.logEvent(
            "lifecycle",
            `${managed.config.label} 内核退出 (${msg.result?.kind}:${msg.result?.code})`,
            nodeId
          );
          this.#emitNodes();
        }
        break;
      }
      case "console_out": {
        const text: string = msg.text ?? "";
        managed.consoleHistory += text;
        if (managed.consoleHistory.length > 65536) {
          managed.consoleHistory = managed.consoleHistory.slice(-40000);
        }
        for (const l of managed.consoleListeners) {
          try {
            l(text);
          } catch {
            // Ignore listener errors.
          }
        }
        break;
      }
      case "rpc_res": {
        const pending = managed.pendingRpcs.get(msg.reqId);
        if (!pending) break;
        managed.pendingRpcs.delete(msg.reqId);
        clearTimeout(pending.timer);
        if (msg.ok) pending.resolve(msg.result);
        else pending.reject(new Error(msg.error ?? "RPC error"));
        break;
      }
      case "pty_data": {
        const pty = managed.ptys.get(msg.ptyId);
        if (pty) {
          try {
            pty.controller.enqueue(
              msg.chunk instanceof Uint8Array ? msg.chunk : new Uint8Array(msg.chunk)
            );
          } catch {
            // Ignore closed stream.
          }
        }
        break;
      }
      case "pty_end": {
        const pty = managed.ptys.get(msg.ptyId);
        if (pty) {
          managed.ptys.delete(msg.ptyId);
          try {
            pty.controller.close();
          } catch {
            // Ignore closed stream.
          }
          pty.resolveEnd(msg.end ?? { type: "exit", code: 0 });
        }
        break;
      }
    }
  }

  #callWorkerRpc<T>(
    nodeId: NodeId,
    action: string,
    payload?: any,
    timeoutMs = 5000
  ): Promise<T> {
    const managed = this.#nodes.get(nodeId);
    if (!managed || !managed.worker) {
      return Promise.reject(new Error(`${nodeId} worker not running`));
    }
    const reqId = this.#nextRpcId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        managed.pendingRpcs.delete(reqId);
        reject(new Error(`RPC ${action} timed out for ${nodeId}`));
      }, timeoutMs);
      managed.pendingRpcs.set(reqId, { resolve, reject, timer });
      managed.worker!.postMessage({ type: "rpc", reqId, action, payload });
    });
  }

  #startTelemetryPolling(): void {
    if (this.#telemetryPollTimer) clearInterval(this.#telemetryPollTimer);
    this.#telemetryPollTimer = setInterval(() => {
      for (const managed of this.#nodes.values()) {
        if (managed.state.lifecycle !== "running" || managed.polling) continue;
        managed.polling = true;
        void this.#pollNodeTelemetry(managed).finally(() => {
          managed.polling = false;
        });
      }
    }, 500);
  }

  async #pollNodeTelemetry(managed: ManagedNode): Promise<void> {
    try {
      const res = await this.#callWorkerRpc<{
        raftRunning: boolean;
        raftStatus: RaftStatus | null;
        kernelTcp: KernelTcpSnapshot | null;
        raftPid: number | null;
      }>(managed.config.nodeId, "collect_telemetry", undefined, 2500);

      if (managed.state.lifecycle !== "running") return;

      managed.state.raftRunning = res.raftRunning;
      managed.state.raftPid = res.raftPid;
      managed.state.raftStatus = res.raftStatus;
      managed.state.kernelTcp = res.kernelTcp;

      if (res.raftStatus) {
        const st = res.raftStatus;
        if (managed.prevTerm !== null && st.term > managed.prevTerm) {
          this.logEvent(
            "raft",
            `${managed.config.label} Term ${managed.prevTerm} -> ${st.term}`,
            managed.config.nodeId
          );
        }
        if (managed.prevRole !== st.role) {
          if (st.role === "Candidate") {
            this.logEvent(
              "raft",
              `${managed.config.label} 转为 Candidate (Term ${st.term})，发起 RequestVote`,
              managed.config.nodeId
            );
          } else if (st.role === "Leader") {
            this.logEvent(
              "raft",
              `${managed.config.label} 当选 Term ${st.term} 新 Leader`,
              managed.config.nodeId
            );
          } else if (managed.prevRole === "Leader" && st.role === "Follower") {
            this.logEvent(
              "raft",
              `${managed.config.label} 退位为 Follower (Term ${st.term})`,
              managed.config.nodeId
            );
          }
        }
        managed.prevRole = st.role;
        managed.prevTerm = st.term;
      } else if (managed.prevRole && managed.prevRole !== "Unknown") {
        managed.prevRole = "Unknown";
      }

      this.#emitNodes();
    } catch {
      // Node may be shutting down or busy.
    }
  }

  #emitNodes(): void {
    this.#events.onNodesChanged?.(this.getNodeStates());
  }

  // --- Chaos & Lifecycle Controls -----------------------------------------

  setLinkChaos(
    src: NodeId,
    dst: NodeId,
    rule: Partial<LinkChaosRule>,
    bidirectional = false
  ): void {
    const applied = this.vSwitch.setRule(src, dst, rule);
    if (bidirectional) {
      this.vSwitch.setRule(dst, src, rule);
    }
    const srcLabel = this.#nodes.get(src)?.config.label ?? src;
    const dstLabel = this.#nodes.get(dst)?.config.label ?? dst;
    const arrow = bidirectional ? "<->" : "->";
    const desc = applied.severed
      ? "物理断线 (severed)"
      : `延迟 ${applied.delayMs}ms (±${applied.jitterMs}ms), 丢包 ${(applied.dropRate * 100).toFixed(0)}%`;
    this.logEvent("chaos", `${srcLabel} ${arrow} ${dstLabel}: ${desc}`, src);
  }

  applySplitBrain(minorityNodeIds: NodeId[]): void {
    this.vSwitch.setSplitBrain(minorityNodeIds);
    const labels = minorityNodeIds.map((id) => this.#nodes.get(id)?.config.label ?? id);
    this.logEvent("chaos", `触发脑裂分区：隔离少数派 {${labels.join(", ")}}`);
  }

  healAllChaos(): void {
    this.vSwitch.resetAllRules();
    for (const m of this.#nodes.values()) {
      m.state.linkUp = true;
    }
    this.logEvent("chaos", "恢复全部链路混沌规则与端口连接 (Heal All)");
    this.#emitNodes();
  }

  setNodeLink(nodeId: NodeId, linkUp: boolean): void {
    const m = this.#nodes.get(nodeId);
    if (!m) return;
    m.state.linkUp = linkUp;
    this.vSwitch.setPortLink(nodeId, linkUp);
    this.logEvent(
      "chaos",
      `${m.config.label} ${linkUp ? "插上网线 (linkUp=true)" : "拔掉网线 (linkUp=false, L2全丢包)"}`,
      nodeId
    );
    this.#emitNodes();
  }

  async killRaftProcess(nodeId: NodeId): Promise<void> {
    const m = this.#nodes.get(nodeId);
    if (!m || m.state.lifecycle !== "running") return;
    const res = await this.#callWorkerRpc<{ killedPid: number | null }>(nodeId, "kill_raft");
    m.state.raftRunning = false;
    m.state.raftPid = null;
    m.state.raftStatus = null;
    this.logEvent(
      "lifecycle",
      `${m.config.label} 执行 SIGKILL (kill -9 PID=${res.killedPid ?? "?"}) — 内核存活，自动发送 TCP RST`,
      nodeId
    );
    this.#emitNodes();
  }

  async startRaftProcess(nodeId: NodeId): Promise<void> {
    const m = this.#nodes.get(nodeId);
    if (!m || m.state.lifecycle !== "running") return;
    const res = await this.#callWorkerRpc<{ pid: number | null; error?: string }>(
      nodeId,
      "start_raft"
    );
    m.state.raftPid = res.pid;
    m.state.raftRunning = !!res.pid;
    this.logEvent(
      "lifecycle",
      `${m.config.label} 重新拉起 raft-node 进程 (PID=${res.pid ?? "?"})`,
      nodeId
    );
    this.#emitNodes();
  }

  powerCutNode(nodeId: NodeId): void {
    const m = this.#nodes.get(nodeId);
    if (!m || !m.worker) return;
    for (const [, p] of m.pendingRpcs) {
      clearTimeout(p.timer);
      p.reject(new Error("Worker terminated (power cut)"));
    }
    m.pendingRpcs.clear();
    for (const [, pty] of m.ptys) {
      try {
        pty.controller.close();
      } catch {}
      pty.resolveEnd({ type: "terminated" });
    }
    m.ptys.clear();

    m.worker.terminate();
    m.worker = null;
    this.vSwitch.detachPort(nodeId);

    m.state.lifecycle = "dead";
    m.state.raftRunning = false;
    m.state.raftPid = null;
    m.state.raftStatus = null;
    this.logEvent(
      "lifecycle",
      `${m.config.label} 硬断电 (worker.terminate) — 内核瞬间消失，无 TCP FIN/RST`,
      nodeId
    );
    this.#emitNodes();
  }

  async rebootNode(nodeId: NodeId): Promise<void> {
    const m = this.#nodes.get(nodeId);
    if (!m) return;
    if (m.worker) {
      try {
        m.worker.terminate();
      } catch {}
      m.worker = null;
    }
    const { kernelModule, raftBinary } = await this.#ensureAssets();
    const peersSpec = this.#configs
      .map((c) => `${c.nodeId}=${c.ip}:${c.raftPort}`)
      .join(",");
    this.logEvent("lifecycle", `${m.config.label} 重建 Web Worker 并冷启动内核...`, nodeId);
    await this.#bootSingleWorker(nodeId, kernelModule, raftBinary, peersSpec);
  }

  async stopCluster(): Promise<void> {
    this.stopWorkload();
    if (this.#telemetryPollTimer) {
      clearInterval(this.#telemetryPollTimer);
      this.#telemetryPollTimer = null;
    }
    for (const m of this.#nodes.values()) {
      for (const [, p] of m.pendingRpcs) {
        clearTimeout(p.timer);
        p.reject(new Error("Cluster stopped"));
      }
      m.pendingRpcs.clear();
      for (const [, pty] of m.ptys) {
        try {
          pty.controller.close();
        } catch {}
        pty.resolveEnd({ type: "stopped" });
      }
      m.ptys.clear();
      if (m.worker) {
        try {
          m.worker.terminate();
        } catch {}
        m.worker = null;
      }
    }
    this.#nodes.clear();
    this.vSwitch.resetAll();
    this.#emitNodes();
  }

  // --- KV Workload Generator ----------------------------------------------

  setWorkloadTarget(target: NodeId | "auto"): void {
    this.#workloadTarget = target;
  }

  startWorkload(intervalMs = 200): void {
    if (this.#workloadTimer) return;
    this.logEvent("workload", `开始 KV 写入压测 (每 ${intervalMs}ms PUT 请求)`);
    this.#workloadTimer = setInterval(() => {
      if (this.#workloadInFlight) return;
      this.#workloadInFlight = true;
      const seq = ++this.#workloadSeq;
      void this.putKV(`k${seq % 50}`, `v${seq}`, this.#workloadTarget).finally(() => {
        this.#workloadInFlight = false;
      });
    }, intervalMs);
    this.#events.onWorkloadChanged?.(this.getWorkloadStats());
  }

  stopWorkload(): void {
    if (!this.#workloadTimer) return;
    clearInterval(this.#workloadTimer);
    this.#workloadTimer = null;
    this.logEvent("workload", "停止 KV 写入压测");
    this.#events.onWorkloadChanged?.(this.getWorkloadStats());
  }

  async putKV(key: string, val: string, target: NodeId | "auto" = "auto"): Promise<WorkloadSample> {
    const chosenId =
      target === "auto"
        ? this.getLeaderNodeId() ??
          [...this.#nodes.values()].find((m) => m.state.lifecycle === "running" && m.state.raftRunning)?.config.nodeId ??
          this.#configs[0]?.nodeId ??
          "node-1"
        : target;

    const seq = this.#workloadTotal + 1;
    const t0 = performance.now();
    let sample: WorkloadSample;

    try {
      const url = `http://127.0.0.1:8080/kv?key=${encodeURIComponent(key)}&val=${encodeURIComponent(val)}`;
      const res = await this.#callWorkerRpc<{ status: number; ok: boolean; text: string }>(
        chosenId,
        "fetch",
        { url, method: "PUT", timeoutMs: 3000 },
        3500
      );
      const latencyMs = Math.round(performance.now() - t0);
      let parsed: any = {};
      try {
        parsed = JSON.parse(res.text);
      } catch {}

      sample = {
        seq,
        ts: performance.now(),
        targetNodeId: chosenId,
        key,
        val,
        ok: res.ok && !!parsed.ok,
        status: res.status,
        latencyMs,
        index: parsed.index,
        term: parsed.term,
        error: parsed.error,
      };
    } catch (err: any) {
      const latencyMs = Math.round(performance.now() - t0);
      sample = {
        seq,
        ts: performance.now(),
        targetNodeId: chosenId,
        key,
        val,
        ok: false,
        status: 0,
        latencyMs,
        error: err?.message ?? String(err),
      };
    }

    this.#workloadTotal++;
    if (sample.ok) {
      this.#workloadSucceeded++;
      this.#workloadLatencies.push(sample.latencyMs);
      if (this.#workloadLatencies.length > 200) {
        this.#workloadLatencies.shift();
      }
    } else {
      this.#workloadFailed++;
    }
    this.#workloadRecent.unshift(sample);
    if (this.#workloadRecent.length > 15) {
      this.#workloadRecent.length = 15;
    }

    this.#events.onWorkloadChanged?.(this.getWorkloadStats());
    return sample;
  }

  // --- Terminal Drawer Bridge (compatible with src/terminal-manager.js) ----

  subscribeConsole(nodeId: NodeId, listener: (text: string) => void): {
    history: string;
    unsubscribe: () => void;
  } {
    const m = this.#nodes.get(nodeId);
    if (!m) return { history: "", unsubscribe: () => {} };
    m.consoleListeners.add(listener);
    return {
      history: m.consoleHistory,
      unsubscribe: () => m.consoleListeners.delete(listener),
    };
  }

  createVmProxy(nodeId: NodeId): WorkerVmProxy {
    const getManaged = () => this.#nodes.get(nodeId);
    return {
      nodeId,
      write: (data) => {
        getManaged()?.worker?.postMessage({ type: "console_write", payload: data });
      },
      resize: (cols, rows) => {
        getManaged()?.worker?.postMessage({
          type: "console_resize",
          payload: { cols, rows },
        });
      },
      spawn: async (_file, _args, opts) => {
        const m = getManaged();
        if (!m || !m.worker || m.state.lifecycle !== "running") {
          throw new Error(`Node ${nodeId} is not running`);
        }
        const ptyId = `${nodeId}-pty-${this.#nextPtySeq++}`;
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const output = new ReadableStream<Uint8Array>({
          start(c) {
            controller = c;
          },
        });
        let resolveEnd!: (v: { type: string; code?: number }) => void;
        let rejectEnd!: (e: Error) => void;
        const ended = new Promise<{ type: string; code?: number }>((res, rej) => {
          resolveEnd = res;
          rejectEnd = rej;
        });

        m.ptys.set(ptyId, { controller, resolveEnd, rejectEnd });

        try {
          await this.#callWorkerRpc(
            nodeId,
            "pty_open",
            {
              ptyId,
              cols: opts?.cols ?? 80,
              rows: opts?.rows ?? 24,
              term: opts?.term ?? "xterm-256color",
              detachable: opts?.detachable ?? true,
            },
            6000
          );
        } catch (err: any) {
          m.ptys.delete(ptyId);
          throw err;
        }

        return {
          output,
          ended,
          write: async (data) => {
            getManaged()?.worker?.postMessage({
              type: "pty_write",
              payload: { ptyId, data },
            });
          },
          resize: (cols, rows) => {
            getManaged()?.worker?.postMessage({
              type: "pty_resize",
              payload: { ptyId, cols, rows },
            });
          },
          close: async () => {
            const cur = getManaged();
            cur?.ptys.delete(ptyId);
            cur?.worker?.postMessage({ type: "pty_close", payload: { ptyId } });
          },
        };
      },
      exec: (file, args) =>
        this.#callWorkerRpc(nodeId, "exec", { file, args }, 8000),
    };
  }
}
