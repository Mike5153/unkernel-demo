export type NodeId = string; // e.g. "node-1", "node-2", "node-3"

export interface NodeConfig {
  nodeId: NodeId;
  label: string;   // e.g. "Node A"
  macHex: string;  // e.g. "52:54:00:00:00:01"
  ip: string;      // e.g. "10.10.0.11"
  raftPort: number;
  httpPort: number;
}

export interface LinkChaosRule {
  delayMs: number;
  jitterMs: number;
  dropRate: number; // 0 ~ 1
  severed: boolean;
  allowReorder?: boolean;
}

export const DEFAULT_LINK_RULE: LinkChaosRule = {
  delayMs: 0,
  jitterMs: 0,
  dropRate: 0,
  severed: false,
  allowReorder: false,
};

export interface SwitchPort {
  nodeId: NodeId;
  macHex: string;
  ip: string;
  port: MessagePort;
  linkUp: boolean;
  rxFrames: number;
  txFrames: number;
  droppedFrames: number;
}

export interface SwitchPortStats {
  nodeId: NodeId;
  macHex: string;
  ip: string;
  linkUp: boolean;
  rxFrames: number;
  txFrames: number;
  droppedFrames: number;
}

export interface LinkTelemetry {
  key: string; // `${src}->${dst}`
  src: NodeId;
  dst: NodeId;
  pps: number;
  bps: number;
  rttMs: number | null;
  retransmitsPerSec: number;
  dupAcksPerSec: number;
  totalRetransmits: number;
  totalDupAcks: number;
  droppedFrames: number;
  lastRetransmitAt: number;
}

export interface TcpSniffEvent {
  ts: number;
  kind: "retransmit" | "dup_ack" | "rst" | "syn";
  srcNodeId?: NodeId;
  dstNodeId?: NodeId;
  srcIp: string;
  sport: number;
  dstIp: string;
  dport: number;
  seq: number;
  ack: number;
  payloadLen: number;
}

export interface SwitchTelemetrySnapshot {
  ts: number;
  ports: SwitchPortStats[];
  links: LinkTelemetry[];
  totalRxFrames: number;
  totalTxFrames: number;
  totalDroppedFrames: number;
  totalRetransmits: number;
  totalDupAcks: number;
  retransmitsPerSec: number;
  dupAcksPerSec: number;
  avgRttMs: number | null;
  totalPps: number;
}

export type RaftRole = "Leader" | "Candidate" | "Follower" | "Unknown";

export interface RaftPeerStatus {
  addr: string;
  nextIndex: number;
  matchIndex: number;
  connected: boolean;
  lastContactMs: number;
  lastRttMs: number;
  lastError?: string;
}

export interface RaftStatus {
  nodeId: string;
  pid: number;
  role: RaftRole;
  term: number;
  leaderId: string;
  votedFor: string;
  commitIndex: number;
  appliedIndex: number;
  lastLogIndex: number;
  lastLogTerm: number;
  kvCount: number;
  uptimeMs: number;
  peers: Record<string, RaftPeerStatus>;
}

export interface KernelTcpStates {
  ESTABLISHED: number;
  SYN_SENT: number;
  SYN_RECV: number;
  FIN_WAIT: number;
  TIME_WAIT: number;
  CLOSE_WAIT: number;
  LISTEN: number;
  OTHER: number;
}

export interface KernelTcpSnapshot {
  ts: number;
  retransSegs: number;
  inSegs: number;
  outSegs: number;
  currEstab: number;
  activeOpens: number;
  estabResets: number;
  states: KernelTcpStates;
}

export type NodeLifecycle =
  | "stopped"
  | "booting"
  | "running"
  | "dead"
  | "error";

export interface NodeRuntimeState {
  config: NodeConfig;
  lifecycle: NodeLifecycle;
  linkUp: boolean;
  raftRunning: boolean;
  raftPid: number | null;
  raftStatus: RaftStatus | null;
  kernelTcp: KernelTcpSnapshot | null;
  bootStage: string;
  error?: string;
}

export interface WorkloadSample {
  seq: number;
  ts: number;
  targetNodeId: NodeId;
  key: string;
  val: string;
  ok: boolean;
  status: number;
  latencyMs: number;
  index?: number;
  term?: number;
  error?: string;
}

export interface WorkloadStats {
  running: boolean;
  total: number;
  succeeded: number;
  failed: number;
  lastLatencyMs: number | null;
  p95LatencyMs: number | null;
  recent: WorkloadSample[];
}

export interface TimelineEvent {
  id: number;
  tsMs: number;
  timeLabel: string;
  category: "chaos" | "tcp" | "raft" | "lifecycle" | "workload";
  nodeId?: NodeId;
  message: string;
}
