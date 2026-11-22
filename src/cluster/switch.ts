import { DhcpResponder, formatMac, ip4ToNum, numToIp4 } from "./dhcp";
import {
  DEFAULT_LINK_RULE,
  type LinkChaosRule,
  type LinkTelemetry,
  type NodeId,
  type SwitchPort,
  type SwitchTelemetrySnapshot,
  type TcpSniffEvent,
} from "./types";

const ETH_IP = 0x0800;
const PROTO_TCP = 6;
const TCP_FIN = 1;
const TCP_SYN = 2;
const TCP_RST = 4;
const TCP_ACK = 16;

const seqLt = (a: number, b: number) => ((a - b) | 0) < 0;
const seqLe = (a: number, b: number) => ((a - b) | 0) <= 0;
const seqGt = (a: number, b: number) => ((a - b) | 0) > 0;
const seqAdd = (a: number, n: number) => (a + n) >>> 0;

interface TcpStreamState {
  hasData: boolean;
  maxSeqEnd: number;
  lastAck: number;
  hasAck: boolean;
  dupAckCount: number;
  pendingRtt: Map<number, number>;
}

interface LinkWindowStats {
  src: NodeId;
  dst: NodeId;
  winFrames: number;
  winBytes: number;
  winRetransmits: number;
  winDupAcks: number;
  totalRetransmits: number;
  totalDupAcks: number;
  droppedFrames: number;
  rttMs: number | null;
  lastRetransmitAt: number;
}

export interface SwitchCallbacks {
  onTelemetry?: (snapshot: SwitchTelemetrySnapshot) => void;
  onTcpEvent?: (ev: TcpSniffEvent) => void;
}

export class VirtualL2Switch {
  readonly #ports = new Map<NodeId, SwitchPort>();
  readonly #macTable = new Map<string, NodeId>();
  readonly #ipToNode = new Map<number, NodeId>();
  readonly #rules = new Map<string, LinkChaosRule>();
  readonly #lastScheduledAt = new Map<string, number>();
  readonly #streams = new Map<string, TcpStreamState>();
  readonly #linkStats = new Map<string, LinkWindowStats>();
  readonly #dhcp = new DhcpResponder();
  readonly #pendingTimers = new Set<ReturnType<typeof setTimeout>>();

  #callbacks: SwitchCallbacks;
  #telemetryTimer: ReturnType<typeof setInterval> | null = null;
  #lastSnapshotTs = performance.now();
  #totalRx = 0;
  #totalTx = 0;
  #totalDropped = 0;
  #totalRetransmits = 0;
  #totalDupAcks = 0;
  #lastSniffByKey = new Map<string, number>();

  constructor(callbacks: SwitchCallbacks = {}) {
    this.#callbacks = callbacks;
  }

  setCallbacks(callbacks: SwitchCallbacks): void {
    this.#callbacks = callbacks;
  }

  startTelemetry(intervalMs = 100): void {
    if (this.#telemetryTimer) return;
    this.#lastSnapshotTs = performance.now();
    this.#telemetryTimer = setInterval(() => {
      this.#flushTelemetry();
    }, intervalMs);
  }

  stopTelemetry(): void {
    if (this.#telemetryTimer) {
      clearInterval(this.#telemetryTimer);
      this.#telemetryTimer = null;
    }
  }

  attachPort(opts: {
    nodeId: NodeId;
    macHex: string;
    ip: string;
    port: MessagePort;
    linkUp?: boolean;
  }): void {
    const existing = this.#ports.get(opts.nodeId);
    if (existing) {
      this.detachPort(opts.nodeId);
    }

    const macHex = opts.macHex.toLowerCase();
    const switchPort: SwitchPort = {
      nodeId: opts.nodeId,
      macHex,
      ip: opts.ip,
      port: opts.port,
      linkUp: opts.linkUp ?? true,
      rxFrames: 0,
      txFrames: 0,
      droppedFrames: 0,
    };

    this.#ports.set(opts.nodeId, switchPort);
    this.#macTable.set(macHex, opts.nodeId);
    this.#ipToNode.set(ip4ToNum(opts.ip), opts.nodeId);
    this.#dhcp.registerNode(macHex, opts.ip);

    // Ensure link stat slots exist for all pairs involving this node.
    for (const otherId of this.#ports.keys()) {
      if (otherId === opts.nodeId) continue;
      this.#ensureLinkStat(opts.nodeId, otherId);
      this.#ensureLinkStat(otherId, opts.nodeId);
    }

    opts.port.onmessage = (ev: MessageEvent<ArrayBuffer | Uint8Array>) => {
      const data = ev.data;
      const frame = data instanceof Uint8Array ? data : new Uint8Array(data);
      this.#onFrame(switchPort, frame);
    };
    opts.port.start?.();
  }

  detachPort(nodeId: NodeId): void {
    const p = this.#ports.get(nodeId);
    if (!p) return;
    p.port.onmessage = null;
    try {
      p.port.close();
    } catch {
      // Ignore already-closed port.
    }
    this.#ports.delete(nodeId);
    this.#macTable.delete(p.macHex);
    this.#ipToNode.delete(ip4ToNum(p.ip));
    this.#dhcp.unregisterNode(p.macHex);
  }

  setPortLink(nodeId: NodeId, linkUp: boolean): void {
    const p = this.#ports.get(nodeId);
    if (p) {
      p.linkUp = linkUp;
    }
  }

  getRule(src: NodeId, dst: NodeId): LinkChaosRule {
    return this.#rules.get(`${src}->${dst}`) ?? DEFAULT_LINK_RULE;
  }

  setRule(src: NodeId, dst: NodeId, rule: Partial<LinkChaosRule>): LinkChaosRule {
    const key = `${src}->${dst}`;
    const prev = this.getRule(src, dst);
    const next: LinkChaosRule = {
      delayMs: Math.max(0, Math.min(2000, rule.delayMs ?? prev.delayMs)),
      jitterMs: Math.max(0, Math.min(300, rule.jitterMs ?? prev.jitterMs)),
      dropRate: Math.max(0, Math.min(1, rule.dropRate ?? prev.dropRate)),
      severed: rule.severed ?? prev.severed,
      allowReorder: rule.allowReorder ?? prev.allowReorder,
    };
    if (
      next.delayMs === 0 &&
      next.jitterMs === 0 &&
      next.dropRate === 0 &&
      !next.severed &&
      !next.allowReorder
    ) {
      this.#rules.delete(key);
    } else {
      this.#rules.set(key, next);
    }
    return next;
  }

  getAllNonDefaultRules(): Array<{ src: NodeId; dst: NodeId; rule: LinkChaosRule }> {
    const out: Array<{ src: NodeId; dst: NodeId; rule: LinkChaosRule }> = [];
    for (const [key, rule] of this.#rules.entries()) {
      const [src, dst] = key.split("->");
      if (src && dst) out.push({ src, dst, rule });
    }
    return out;
  }

  setSplitBrain(minorityIds: NodeId[]): void {
    const minority = new Set(minorityIds);
    const allIds = [...this.#ports.keys()];
    for (const a of allIds) {
      for (const b of allIds) {
        if (a === b) continue;
        const cross = minority.has(a) !== minority.has(b);
        this.setRule(a, b, { severed: cross });
      }
    }
  }

  resetAllRules(): void {
    this.#rules.clear();
    this.#lastScheduledAt.clear();
    for (const port of this.#ports.values()) {
      port.linkUp = true;
    }
  }

  resetAll(): void {
    this.stopTelemetry();
    for (const t of this.#pendingTimers) {
      clearTimeout(t);
    }
    this.#pendingTimers.clear();
    for (const id of [...this.#ports.keys()]) {
      this.detachPort(id);
    }
    this.#macTable.clear();
    this.#ipToNode.clear();
    this.#rules.clear();
    this.#lastScheduledAt.clear();
    this.#streams.clear();
    this.#linkStats.clear();
    this.#totalRx = 0;
    this.#totalTx = 0;
    this.#totalDropped = 0;
    this.#totalRetransmits = 0;
    this.#totalDupAcks = 0;
  }

  #ensureLinkStat(src: NodeId, dst: NodeId): LinkWindowStats {
    const key = `${src}->${dst}`;
    let st = this.#linkStats.get(key);
    if (!st) {
      st = {
        src,
        dst,
        winFrames: 0,
        winBytes: 0,
        winRetransmits: 0,
        winDupAcks: 0,
        totalRetransmits: 0,
        totalDupAcks: 0,
        droppedFrames: 0,
        rttMs: null,
        lastRetransmitAt: 0,
      };
      this.#linkStats.set(key, st);
    }
    return st;
  }

  #onFrame(srcPort: SwitchPort, frame: Uint8Array): void {
    if (frame.length < 14) return;
    srcPort.rxFrames++;
    this.#totalRx++;

    // 1. Port isolation check (cable unplugged on source).
    if (!srcPort.linkUp) {
      srcPort.droppedFrames++;
      this.#totalDropped++;
      return;
    }

    // 2. Intercept DHCP requests (UDP dst port 67) & reply directly to srcPort.
    if (this.#dhcp.isDhcpRequestFrame(frame)) {
      const reply = this.#dhcp.handleFrame(frame, srcPort.macHex);
      if (reply) {
        srcPort.txFrames++;
        this.#totalTx++;
        srcPort.port.postMessage(reply.buffer, [reply.buffer]);
      }
      return;
    }

    // 3. Learn source MAC and resolve destination port(s).
    const srcMacHex = formatMac(frame, 6).toLowerCase();
    this.#macTable.set(srcMacHex, srcPort.nodeId);

    const isMulticastOrBroadcast = (frame[0]! & 0x01) !== 0;
    const targets: SwitchPort[] = [];

    if (isMulticastOrBroadcast) {
      for (const port of this.#ports.values()) {
        if (port.nodeId !== srcPort.nodeId) targets.push(port);
      }
    } else {
      const dstMacHex = formatMac(frame, 0).toLowerCase();
      const dstNodeId = this.#macTable.get(dstMacHex);
      const dstPort = dstNodeId ? this.#ports.get(dstNodeId) : undefined;
      if (dstPort && dstPort.nodeId !== srcPort.nodeId) {
        targets.push(dstPort);
      } else if (!dstNodeId) {
        // Unknown unicast: flood to other ports.
        for (const port of this.#ports.values()) {
          if (port.nodeId !== srcPort.nodeId) targets.push(port);
        }
      }
    }

    if (targets.length === 0) return;

    // 4. Read-only passive TCP sniffer (before chaos drops/delays).
    this.#sniffTcp(srcPort, frame);

    // 5. Per-target chaos rules & ordered delivery pipeline.
    const now = performance.now();
    for (let i = 0; i < targets.length; i++) {
      const dstPort = targets[i]!;
      const rule = this.getRule(srcPort.nodeId, dstPort.nodeId);
      const linkKey = `${srcPort.nodeId}->${dstPort.nodeId}`;
      const stat = this.#ensureLinkStat(srcPort.nodeId, dstPort.nodeId);

      if (!dstPort.linkUp || rule.severed) {
        dstPort.droppedFrames++;
        stat.droppedFrames++;
        this.#totalDropped++;
        continue;
      }

      if (rule.dropRate > 0 && Math.random() < rule.dropRate) {
        dstPort.droppedFrames++;
        stat.droppedFrames++;
        this.#totalDropped++;
        continue;
      }

      stat.winFrames++;
      stat.winBytes += frame.byteLength;

      const outFrame = i === targets.length - 1 && targets.length === 1 ? frame : frame.slice();

      if (rule.delayMs === 0 && rule.jitterMs === 0) {
        dstPort.txFrames++;
        this.#totalTx++;
        dstPort.port.postMessage(outFrame.buffer, [outFrame.buffer]);
      } else {
        const jitter =
          rule.jitterMs > 0 ? (Math.random() * 2 - 1) * rule.jitterMs : 0;
        const targetTime = now + Math.max(0, rule.delayMs + jitter);
        let deliverAt = targetTime;
        if (!rule.allowReorder) {
          const prevAt = this.#lastScheduledAt.get(linkKey) ?? 0;
          deliverAt = Math.max(prevAt, targetTime);
          this.#lastScheduledAt.set(linkKey, deliverAt);
        }
        const waitMs = Math.max(0, deliverAt - now);
        const timer = setTimeout(() => {
          this.#pendingTimers.delete(timer);
          if (!this.#ports.has(dstPort.nodeId) || !dstPort.linkUp) {
            dstPort.droppedFrames++;
            stat.droppedFrames++;
            this.#totalDropped++;
            return;
          }
          dstPort.txFrames++;
          this.#totalTx++;
          dstPort.port.postMessage(outFrame.buffer, [outFrame.buffer]);
        }, waitMs);
        this.#pendingTimers.add(timer);
      }
    }
  }

  #sniffTcp(srcPort: SwitchPort, frame: Uint8Array): void {
    if (frame.length < 14 + 20 + 20) return;
    const etherType = (frame[12]! << 8) | frame[13]!;
    if (etherType !== ETH_IP) return;
    if ((frame[14]! >> 4) !== 4) return;
    if (frame[23] !== PROTO_TCP) return;

    const ihl = (frame[14]! & 0x0f) * 4;
    const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const ipTotal = dv.getUint16(16);
    const l4 = 14 + ihl;
    const end = Math.min(frame.length, ipTotal ? 14 + ipTotal : frame.length);
    if (end - l4 < 20) return;

    const tcpHdrLen = (frame[l4 + 12]! >> 4) * 4;
    if (end - l4 < tcpHdrLen) return;

    const srcIpNum = dv.getUint32(26);
    const dstIpNum = dv.getUint32(30);
    const sport = dv.getUint16(l4);
    const dport = dv.getUint16(l4 + 2);
    const seq = dv.getUint32(l4 + 4);
    const ack = dv.getUint32(l4 + 8);
    const flags = frame[l4 + 13]!;
    const payloadLen = Math.max(0, end - (l4 + tcpHdrLen));

    const srcNodeId = this.#ipToNode.get(srcIpNum) ?? srcPort.nodeId;
    const dstNodeId = this.#ipToNode.get(dstIpNum);
    const now = performance.now();

    const fwdKey = `${srcIpNum}:${sport}->${dstIpNum}:${dport}`;
    const revKey = `${dstIpNum}:${dport}->${srcIpNum}:${sport}`;

    let fwd = this.#streams.get(fwdKey);
    if (!fwd || ((flags & TCP_SYN) !== 0 && (flags & TCP_ACK) === 0)) {
      fwd = {
        hasData: false,
        maxSeqEnd: seqAdd(seq, payloadLen + ((flags & TCP_SYN) ? 1 : 0)),
        lastAck: 0,
        hasAck: false,
        dupAckCount: 0,
        pendingRtt: new Map(),
      };
      this.#streams.set(fwdKey, fwd);
    }

    const linkStat = dstNodeId ? this.#ensureLinkStat(srcNodeId, dstNodeId) : undefined;
    const revStat = dstNodeId ? this.#ensureLinkStat(dstNodeId, srcNodeId) : undefined;

    // Retransmission check: segment carries payload and starts before maxSeqEnd
    if (payloadLen > 0) {
      if (fwd.hasData && seqLt(seq, fwd.maxSeqEnd)) {
        this.#totalRetransmits++;
        if (linkStat) {
          linkStat.winRetransmits++;
          linkStat.totalRetransmits++;
          linkStat.lastRetransmitAt = now;
        }
        this.#emitTcpEvent({
          ts: now,
          kind: "retransmit",
          srcNodeId,
          dstNodeId,
          srcIp: numToIp4(srcIpNum),
          sport,
          dstIp: numToIp4(dstIpNum),
          dport,
          seq,
          ack,
          payloadLen,
        });
      }

      const seqEnd = seqAdd(seq, payloadLen);
      if (!fwd.hasData || seqGt(seqEnd, fwd.maxSeqEnd)) {
        fwd.hasData = true;
        fwd.maxSeqEnd = seqEnd;
        // Track RTT sample for newest segment end (cap map size)
        if (fwd.pendingRtt.size > 64) {
          const oldest = fwd.pendingRtt.keys().next().value;
          if (oldest !== undefined) fwd.pendingRtt.delete(oldest);
        }
        fwd.pendingRtt.set(seqEnd, now);
      }
    }

    // Reverse stream matching for ACK -> RTT sampling & DupACK detection
    const rev = this.#streams.get(revKey);
    if (flags & TCP_ACK) {
      if (rev && rev.pendingRtt.size > 0) {
        let matchedSendTime: number | null = null;
        for (const [expectedAck, sentAt] of rev.pendingRtt.entries()) {
          if (seqLe(expectedAck, ack)) {
            matchedSendTime = sentAt;
            rev.pendingRtt.delete(expectedAck);
          }
        }
        if (matchedSendTime !== null && revStat) {
          const sampleRtt = Math.max(0.1, now - matchedSendTime);
          revStat.rttMs =
            revStat.rttMs === null ? sampleRtt : revStat.rttMs * 0.7 + sampleRtt * 0.3;
        }
      }

      const isPureAck =
        payloadLen === 0 && (flags & (TCP_SYN | TCP_FIN | TCP_RST)) === 0;
      if (isPureAck && rev && rev.hasData) {
        if (fwd.hasAck && ack === fwd.lastAck && seqLt(ack, rev.maxSeqEnd)) {
          fwd.dupAckCount++;
          if (fwd.dupAckCount === 3) {
            this.#totalDupAcks++;
            if (linkStat) {
              linkStat.winDupAcks++;
              linkStat.totalDupAcks++;
            }
            this.#emitTcpEvent({
              ts: now,
              kind: "dup_ack",
              srcNodeId,
              dstNodeId,
              srcIp: numToIp4(srcIpNum),
              sport,
              dstIp: numToIp4(dstIpNum),
              dport,
              seq,
              ack,
              payloadLen,
            });
          }
        } else {
          fwd.dupAckCount = 0;
        }
      } else {
        fwd.dupAckCount = 0;
      }
      fwd.lastAck = ack;
      fwd.hasAck = true;
    }

    if (flags & TCP_RST) {
      this.#emitTcpEvent({
        ts: now,
        kind: "rst",
        srcNodeId,
        dstNodeId,
        srcIp: numToIp4(srcIpNum),
        sport,
        dstIp: numToIp4(dstIpNum),
        dport,
        seq,
        ack,
        payloadLen,
      });
    }
  }

  #emitTcpEvent(ev: TcpSniffEvent): void {
    // Avoid flooding UI listeners during heavy loss storms, while keeping rst and distinct directions responsive.
    const key = `${ev.kind}:${ev.srcIp}->${ev.dstIp}`;
    const prev = this.#lastSniffByKey.get(key) ?? -Infinity;
    if (ev.kind !== "rst" && ev.ts - prev < 50) {
      return;
    }
    this.#lastSniffByKey.set(key, ev.ts);
    this.#callbacks.onTcpEvent?.(ev);
  }

  #flushTelemetry(): void {
    const now = performance.now();
    const dtSec = Math.max(0.05, (now - this.#lastSnapshotTs) / 1000);
    this.#lastSnapshotTs = now;

    const links: LinkTelemetry[] = [];
    let totalPps = 0;
    let retransPerSec = 0;
    let dupAcksPerSec = 0;
    let rttSum = 0;
    let rttCount = 0;

    for (const [key, st] of this.#linkStats.entries()) {
      const pps = st.winFrames / dtSec;
      const bps = st.winBytes / dtSec;
      const rps = st.winRetransmits / dtSec;
      const dps = st.winDupAcks / dtSec;

      totalPps += pps;
      retransPerSec += rps;
      dupAcksPerSec += dps;
      if (st.rttMs !== null) {
        rttSum += st.rttMs;
        rttCount++;
      }

      links.push({
        key,
        src: st.src,
        dst: st.dst,
        pps,
        bps,
        rttMs: st.rttMs,
        retransmitsPerSec: rps,
        dupAcksPerSec: dps,
        totalRetransmits: st.totalRetransmits,
        totalDupAcks: st.totalDupAcks,
        droppedFrames: st.droppedFrames,
        lastRetransmitAt: st.lastRetransmitAt,
      });

      st.winFrames = 0;
      st.winBytes = 0;
      st.winRetransmits = 0;
      st.winDupAcks = 0;
    }

    const ports = [...this.#ports.values()].map((p) => ({
      nodeId: p.nodeId,
      macHex: p.macHex,
      ip: p.ip,
      linkUp: p.linkUp,
      rxFrames: p.rxFrames,
      txFrames: p.txFrames,
      droppedFrames: p.droppedFrames,
    }));

    this.#callbacks.onTelemetry?.({
      ts: now,
      ports,
      links,
      totalRxFrames: this.#totalRx,
      totalTxFrames: this.#totalTx,
      totalDroppedFrames: this.#totalDropped,
      totalRetransmits: this.#totalRetransmits,
      totalDupAcks: this.#totalDupAcks,
      retransmitsPerSec,
      dupAcksPerSec,
      avgRttMs: rttCount > 0 ? rttSum / rttCount : null,
      totalPps,
    });
  }
}
