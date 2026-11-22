/// <reference lib="webworker" />
import {
  ConsoleRouter,
  MemoryFs,
  createKernel,
  type KernelInstance,
  type Pty,
} from "unkernel";
import { parseMac } from "./dhcp";
import { createWorkerBridgeNetDevice } from "./net-device";
import type { KernelTcpSnapshot, KernelTcpStates, RaftStatus } from "./types";

interface BootMessage {
  type: "boot";
  nodeId: string;
  macHex: string;
  expectedIp: string;
  kernelModule: WebAssembly.Module;
  netPort: MessagePort;
  memoryMiB?: number;
  memoryFallbackMiB?: number[];
  raftBinary: Uint8Array;
  peersSpec: string;
}

interface RpcRequest {
  type: "rpc";
  reqId: number;
  action:
    | "exec"
    | "fetch"
    | "collect_telemetry"
    | "kill_raft"
    | "start_raft"
    | "pty_open"
    | "stop";
  payload?: any;
}

interface FireMessage {
  type: "console_write" | "console_resize" | "pty_write" | "pty_resize" | "pty_close";
  payload: any;
}

type WorkerInMessage = BootMessage | RpcRequest | FireMessage;

let vm: KernelInstance | null = null;
let nodeId = "";
let peersSpec = "";
let raftPid: number | null = null;
let userspaceReady = false;
let resolveUserspaceReady: (() => void) | null = null;
const userspacePromise = new Promise<void>((resolve) => {
  resolveUserspaceReady = resolve;
});
const activePtys = new Map<string, Pty>();

function post(msg: any, transfer?: Transferable[]): void {
  if (transfer && transfer.length > 0) {
    self.postMessage(msg, transfer);
  } else {
    self.postMessage(msg);
  }
}

function parseSnmp(text: string): Omit<KernelTcpSnapshot, "ts" | "states"> | null {
  const lines = text.split(/\r?\n/);
  let headers: string[] | null = null;
  let values: string[] | null = null;
  for (const line of lines) {
    if (!line.startsWith("Tcp:")) continue;
    const cols = line.slice(4).trim().split(/\s+/);
    if (!headers) {
      headers = cols;
    } else {
      values = cols;
      break;
    }
  }
  if (!headers || !values) return null;
  const map = new Map<string, number>();
  for (let i = 0; i < headers.length && i < values.length; i++) {
    map.set(headers[i]!, Number(values[i]!) || 0);
  }
  return {
    retransSegs: map.get("RetransSegs") ?? 0,
    inSegs: map.get("InSegs") ?? 0,
    outSegs: map.get("OutSegs") ?? 0,
    currEstab: map.get("CurrEstab") ?? 0,
    activeOpens: map.get("ActiveOpens") ?? 0,
    estabResets: map.get("EstabResets") ?? 0,
  };
}

function parseProcNetTcp(text: string): KernelTcpStates {
  const states: KernelTcpStates = {
    ESTABLISHED: 0,
    SYN_SENT: 0,
    SYN_RECV: 0,
    FIN_WAIT: 0,
    TIME_WAIT: 0,
    CLOSE_WAIT: 0,
    LISTEN: 0,
    OTHER: 0,
  };
  const lines = text.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    const cols = line.split(/\s+/);
    const stHex = cols[3];
    if (!stHex) continue;
    switch (stHex.toUpperCase()) {
      case "01":
        states.ESTABLISHED++;
        break;
      case "02":
        states.SYN_SENT++;
        break;
      case "03":
        states.SYN_RECV++;
        break;
      case "04":
      case "05":
        states.FIN_WAIT++;
        break;
      case "06":
        states.TIME_WAIT++;
        break;
      case "08":
        states.CLOSE_WAIT++;
        break;
      case "0A":
        states.LISTEN++;
        break;
      default:
        states.OTHER++;
        break;
    }
  }
  return states;
}

async function startRaftProcess(): Promise<{ pid: number | null; error?: string }> {
  if (!vm) return { pid: null, error: "VM not booted" };
  const cmd = [
    "mkdir -p /tmp/raft-data",
    `(/opt/raft/raft-node --id=${nodeId} --listen=0.0.0.0:2380 --http=0.0.0.0:8080 --peers='${peersSpec}' --heartbeat=150 --election-min=1000 --election-max=1500 --data-dir=/tmp/raft-data >/tmp/raft.log 2>&1 </dev/null & echo $!)`,
  ].join(" && ");
  const res = await vm.exec("/bin/sh", ["-c", cmd]);
  const parsed = parseInt(res.stdout.trim().split(/\s+/).pop() ?? "", 10);
  raftPid = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  if (res.exitCode !== 0) {
    return { pid: raftPid, error: res.stderr || `exit ${res.exitCode}` };
  }
  return { pid: raftPid };
}

async function killRaftProcess(): Promise<{ killedPid: number | null; output: string }> {
  if (!vm) return { killedPid: null, output: "VM not booted" };
  const prevPid = raftPid;
  const cmd = prevPid
    ? `kill -9 ${prevPid} 2>/dev/null; for p in $(ps | awk '/raft-node/ && !/awk/ {print $1}'); do kill -9 "$p" 2>/dev/null; done; echo ok`
    : `for p in $(ps | awk '/raft-node/ && !/awk/ {print $1}'); do kill -9 "$p" 2>/dev/null; done; echo ok`;
  const res = await vm.exec("/bin/sh", ["-c", cmd]);
  raftPid = null;
  return { killedPid: prevPid, output: (res.stdout + res.stderr).trim() };
}

async function collectTelemetry(): Promise<{
  raftRunning: boolean;
  raftStatus: RaftStatus | null;
  kernelTcp: KernelTcpSnapshot | null;
  raftPid: number | null;
}> {
  if (!vm) {
    return { raftRunning: false, raftStatus: null, kernelTcp: null, raftPid: null };
  }

  let raftRunning = false;
  let raftStatus: RaftStatus | null = null;
  let kernelTcp: KernelTcpSnapshot | null = null;

  const statusPromise = (async () => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 900);
    try {
      const resp = await vm!.fetch("http://127.0.0.1:8080/_chaos/status", {
        signal: ac.signal,
      });
      if (resp.ok) {
        const data = (await resp.json()) as RaftStatus;
        raftStatus = data;
        raftRunning = true;
        if (data.pid) raftPid = data.pid;
      }
    } catch {
      raftRunning = false;
      raftStatus = null;
    } finally {
      clearTimeout(timer);
    }
  })();

  const tcpPromise = (async () => {
    try {
      const res = await vm!.exec("/bin/sh", [
        "-c",
        "cat /proc/net/snmp 2>/dev/null; echo ===TCP===; cat /proc/net/tcp 2>/dev/null",
      ]);
      if (res.exitCode === 0 && res.stdout) {
        const [snmpPart = "", tcpPart = ""] = res.stdout.split("===TCP===");
        const snmp = parseSnmp(snmpPart);
        const states = parseProcNetTcp(tcpPart);
        if (snmp) {
          kernelTcp = {
            ts: performance.now(),
            ...snmp,
            states,
          };
        }
      }
    } catch {
      // Ignore transient exec errors during shutdown.
    }
  })();

  await Promise.all([statusPromise, tcpPromise]);
  return { raftRunning, raftStatus, kernelTcp, raftPid };
}

async function handleBoot(msg: BootMessage): Promise<void> {
  nodeId = msg.nodeId;
  peersSpec = msg.peersSpec;

  const memFs = new MemoryFs();
  memFs.writeFile("/raft-node", msg.raftBinary, { mode: 0o755 });

  const macBytes = parseMac(msg.macHex);
  const netDevice = createWorkerBridgeNetDevice(macBytes, msg.netPort);

  try {
    vm = await createKernel({
      kernel: msg.kernelModule,
      memoryMiB: msg.memoryMiB ?? 256,
      memoryFallbackMiB: msg.memoryFallbackMiB ?? [256, 192, 128],
      net: netDevice,
      mounts: {
        "/opt/raft": memFs,
      },
      consoleSize: { cols: 100, rows: 28 },
      onProgress: (p) => {
        post({ type: "boot_progress", nodeId, progress: p });
      },
    });
  } catch (err: any) {
    post({
      type: "boot_error",
      nodeId,
      error: err?.message ?? String(err),
    });
    return;
  }

  const router = new ConsoleRouter({
    onKernelLine: (line) => {
      post({ type: "console_out", nodeId, text: `${line}\r\n` });
    },
    onUserOutput: (text) => {
      post({ type: "console_out", nodeId, text });
    },
    onUserspace: () => {
      if (!userspaceReady) {
        userspaceReady = true;
        resolveUserspaceReady?.();
      }
    },
  });

  const reader = vm.output.getReader();
  void (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        router.write(value);
      }
      router.flush();
    } catch {
      // Stream closes on exit.
    } finally {
      reader.releaseLock();
    }
  })();

  void vm.exited.then((result) => {
    userspaceReady = true;
    resolveUserspaceReady?.();
    post({ type: "vm_exited", nodeId, result });
    vm = null;
  });

  // Wait until userspace (/etc/inittab & kwtty) is ready.
  await userspacePromise;

  // Verify eth0 received its DHCP lease (wait briefly if udhcpc is still settling).
  let ip = msg.expectedIp;
  try {
    const ipRes = await vm.exec("/bin/sh", [
      "-c",
      "i=0; while [ $i -lt 20 ]; do ip -4 -o addr show dev eth0 2>/dev/null | grep -q 'inet ' && break; i=$((i+1)); sleep 0.1; done; ip -4 -o addr show dev eth0 2>/dev/null",
    ]);
    const m = /inet\s+(\d+\.\d+\.\d+\.\d+)/.exec(ipRes.stdout);
    if (m?.[1]) ip = m[1];
  } catch {
    // Fallback to expectedIp.
  }

  const startRes = await startRaftProcess();
  post({
    type: "ready",
    nodeId,
    ip,
    raftPid: startRes.pid,
    error: startRes.error,
  });
}

async function handleRpc(msg: RpcRequest): Promise<void> {
  const { reqId, action, payload } = msg;
  try {
    if (!vm && action !== "stop") {
      throw new Error("VM is not running");
    }
    switch (action) {
      case "exec": {
        const res = await vm!.exec(payload.file, payload.args, payload.opts);
        post({ type: "rpc_res", reqId, ok: true, result: res });
        break;
      }
      case "fetch": {
        const ac = new AbortController();
        const timeoutMs = payload.timeoutMs ?? 3500;
        const timer = setTimeout(() => ac.abort(), timeoutMs);
        try {
          const resp = await vm!.fetch(payload.url, {
            method: payload.method ?? "GET",
            headers: payload.headers,
            body: payload.body,
            signal: ac.signal,
          });
          const text = await resp.text();
          post({
            type: "rpc_res",
            reqId,
            ok: true,
            result: { status: resp.status, ok: resp.ok, text },
          });
        } finally {
          clearTimeout(timer);
        }
        break;
      }
      case "collect_telemetry": {
        const res = await collectTelemetry();
        post({ type: "rpc_res", reqId, ok: true, result: res });
        break;
      }
      case "kill_raft": {
        const res = await killRaftProcess();
        post({ type: "rpc_res", reqId, ok: true, result: res });
        break;
      }
      case "start_raft": {
        const res = await startRaftProcess();
        post({ type: "rpc_res", reqId, ok: true, result: res });
        break;
      }
      case "pty_open": {
        await userspacePromise;
        const pty = await vm!.spawn(undefined, undefined, {
          cols: payload.cols ?? 80,
          rows: payload.rows ?? 24,
          term: payload.term ?? "xterm-256color",
          detachable: payload.detachable ?? true,
        });
        const ptyId: string = payload.ptyId;
        activePtys.set(ptyId, pty);

        void (async () => {
          const reader = pty.output.getReader();
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              const copy = value.slice();
              post({ type: "pty_data", ptyId, chunk: copy }, [copy.buffer]);
            }
          } catch {
            // Stream closed.
          } finally {
            reader.releaseLock();
          }
        })();

        void pty.ended
          .then((end) => {
            activePtys.delete(ptyId);
            post({ type: "pty_end", ptyId, end });
          })
          .catch((err) => {
            activePtys.delete(ptyId);
            post({
              type: "pty_end",
              ptyId,
              end: { type: "error", message: err?.message ?? String(err) },
            });
          });

        post({ type: "rpc_res", reqId, ok: true, result: { ptyId } });
        break;
      }
      case "stop": {
        if (vm) {
          await vm.stop();
        }
        post({ type: "rpc_res", reqId, ok: true, result: { stopped: true } });
        break;
      }
    }
  } catch (err: any) {
    post({
      type: "rpc_res",
      reqId,
      ok: false,
      error: err?.message ?? String(err),
    });
  }
}

self.onmessage = (ev: MessageEvent<WorkerInMessage>) => {
  const msg = ev.data;
  if (!msg) return;
  if (msg.type === "boot") {
    void handleBoot(msg);
  } else if (msg.type === "rpc") {
    void handleRpc(msg);
  } else if (msg.type === "console_write") {
    vm?.write(msg.payload);
  } else if (msg.type === "console_resize") {
    vm?.resize(msg.payload.cols, msg.payload.rows);
  } else if (msg.type === "pty_write") {
    const pty = activePtys.get(msg.payload.ptyId);
    if (pty) void pty.write(msg.payload.data).catch(() => {});
  } else if (msg.type === "pty_resize") {
    const pty = activePtys.get(msg.payload.ptyId);
    if (pty) pty.resize(msg.payload.cols, msg.payload.rows);
  } else if (msg.type === "pty_close") {
    const pty = activePtys.get(msg.payload.ptyId);
    if (pty) {
      activePtys.delete(msg.payload.ptyId);
      void pty.close().catch(() => {});
    }
  }
};
