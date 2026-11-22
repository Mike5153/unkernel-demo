const ETH_IP = 0x0800;
const PROTO_UDP = 17;

export function ip4ToNum(s: string): number {
  return s.split(".").reduce((acc, part) => ((acc << 8) | Number(part)) >>> 0, 0);
}

export function numToIp4(n: number): string {
  return `${n >>> 24}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
}

export function parseMac(hex: string): Uint8Array {
  return Uint8Array.from(hex.split(":").map((h) => parseInt(h, 16)));
}

export function formatMac(frame: Uint8Array, offset: number): string {
  const parts: string[] = [];
  for (let i = 0; i < 6; i++) {
    parts.push((frame[offset + i] ?? 0).toString(16).padStart(2, "0"));
  }
  return parts.join(":");
}

function sum16(u8: Uint8Array, off: number, len: number, s = 0): number {
  const end = off + len;
  let i = off;
  for (; i + 1 < end; i += 2) {
    s += (u8[i]! << 8) | u8[i + 1]!;
  }
  if (i < end) {
    s += u8[i]! << 8;
  }
  return s;
}

function fold16(s: number): number {
  while (s > 0xffff) {
    s = (s & 0xffff) + Math.floor(s / 65536);
  }
  return ~s & 0xffff;
}

function bytes4(n: number): number[] {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

/**
 * Minimal L2 DHCP Responder for virtual switch bootstrap.
 * Answers DISCOVER/REQUEST/INFORM on UDP port 67 using MAC -> IP mapping,
 * matching unkernel's /usr/lib/kw/net udhcpc expectations.
 */
export class DhcpResponder {
  readonly #macToIp = new Map<string, number>();
  readonly #serverIp = ip4ToNum("10.10.0.1");
  readonly #netIp = ip4ToNum("10.10.0.0");
  readonly #maskIp = ip4ToNum("255.255.255.0");
  readonly #serverMac = parseMac("52:55:0a:0a:00:01");
  #ipId = 1;

  registerNode(macHex: string, ipStr: string): void {
    this.#macToIp.set(macHex.toLowerCase(), ip4ToNum(ipStr));
  }

  unregisterNode(macHex: string): void {
    this.#macToIp.delete(macHex.toLowerCase());
  }

  isDhcpRequestFrame(frame: Uint8Array): boolean {
    if (frame.length < 14 + 20 + 8) return false;
    const etherType = (frame[12]! << 8) | frame[13]!;
    if (etherType !== ETH_IP) return false;
    if ((frame[14]! >> 4) !== 4) return false;
    const ihl = (frame[14]! & 0x0f) * 4;
    if (frame[23] !== PROTO_UDP) return false;
    const l4 = 14 + ihl;
    if (frame.length < l4 + 8) return false;
    const dport = (frame[l4 + 2]! << 8) | frame[l4 + 3]!;
    return dport === 67;
  }

  handleFrame(frame: Uint8Array, portMacHex: string): Uint8Array | null {
    if (!this.isDhcpRequestFrame(frame)) return null;
    const ihl = (frame[14]! & 0x0f) * 4;
    const l4 = 14 + ihl;
    const dv = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const udpLen = dv.getUint16(l4 + 4);
    const payloadEnd = Math.min(frame.length, l4 + udpLen);
    const p = frame.subarray(l4 + 8, payloadEnd);
    if (p.length < 240 || p[0] !== 1) return null;

    const pdv = new DataView(p.buffer, p.byteOffset, p.byteLength);
    if (pdv.getUint32(236) !== 0x63825363) return null;

    let msgType = 0;
    for (let i = 240; i < p.length && p[i] !== 255; ) {
      if (p[i] === 0) {
        i++;
        continue;
      }
      const opt = p[i]!;
      const len = p[i + 1] ?? 0;
      if (opt === 53 && len >= 1) {
        msgType = p[i + 2] ?? 0;
      }
      i += 2 + len;
    }

    const replyType = msgType === 1 ? 2 : msgType === 3 || msgType === 8 ? 5 : 0;
    if (!replyType) return null;

    const chaddrHex = formatMac(p, 28).toLowerCase();
    const assignedIp =
      this.#macToIp.get(chaddrHex) ?? this.#macToIp.get(portMacHex.toLowerCase());
    if (assignedIp === undefined) return null;

    const broadcastIp = (this.#netIp | ~this.#maskIp) >>> 0;
    const opts: number[] = [
      53, 1, replyType,
      54, 4, ...bytes4(this.#serverIp),
    ];
    if (msgType !== 8) {
      opts.push(51, 4, ...bytes4(86400));
    }
    opts.push(
      1, 4, ...bytes4(this.#maskIp),
      3, 4, ...bytes4(this.#serverIp),
      6, 4, ...bytes4(this.#serverIp),
      28, 4, ...bytes4(broadcastIp),
      255
    );

    const bootp = new Uint8Array(240 + opts.length);
    const bdv = new DataView(bootp.buffer);
    bootp[0] = 2; // BOOTREPLY
    bootp[1] = 1; // Ethernet
    bootp[2] = 6; // MAC len
    bootp.set(p.subarray(4, 8), 4);     // xid
    bootp.set(p.subarray(10, 12), 10);  // flags
    bootp.set(p.subarray(12, 16), 12);  // ciaddr
    if (msgType !== 8) {
      bdv.setUint32(16, assignedIp);    // yiaddr
    }
    bdv.setUint32(20, this.#serverIp);  // siaddr
    bootp.set(p.subarray(28, 44), 28);  // chaddr
    bdv.setUint32(236, 0x63825363);
    bootp.set(opts, 240);

    return this.#buildUdpFrame(
      this.#serverIp,
      67,
      0xffffffff,
      68,
      bootp,
      Uint8Array.of(255, 255, 255, 255, 255, 255)
    );
  }

  #buildUdpFrame(
    srcIp: number,
    sport: number,
    dstIp: number,
    dport: number,
    payload: Uint8Array,
    dstMac: Uint8Array
  ): Uint8Array {
    const l4Len = 8 + payload.length;
    const frame = new Uint8Array(14 + 20 + l4Len);
    frame.set(dstMac, 0);
    frame.set(this.#serverMac, 6);
    frame[12] = 0x08;
    frame[13] = 0x00;

    const dv = new DataView(frame.buffer);
    frame[14] = 0x45;
    dv.setUint16(16, 20 + l4Len);
    this.#ipId = (this.#ipId + 1) & 0xffff;
    dv.setUint16(18, this.#ipId);
    dv.setUint16(20, 0x4000); // DF
    frame[22] = 64;
    frame[23] = PROTO_UDP;
    dv.setUint32(26, srcIp);
    dv.setUint32(30, dstIp);
    dv.setUint16(24, fold16(sum16(frame, 14, 20)));

    dv.setUint16(34, sport);
    dv.setUint16(36, dport);
    dv.setUint16(38, l4Len);
    frame.set(payload, 42);

    const pseudo =
      (srcIp >>> 16) +
      (srcIp & 0xffff) +
      (dstIp >>> 16) +
      (dstIp & 0xffff) +
      PROTO_UDP +
      l4Len;
    dv.setUint16(40, fold16(sum16(frame, 34, l4Len, pseudo)) || 0xffff);
    return frame;
  }
}
