import type { Kernel } from "unkernel";
import type {
  CowPhysicalFrame,
  GuestSnapshot,
  IntrospectionReport,
  PageMappingStatus,
  Sv39Entry,
  Sv39PteFlags,
  Sv39WalkResult,
} from "./types";

const PAGE_SIZE = 4096;
const PPN_MASK = (1n << 44n) - 1n;
const CANARY_PREFIX = new TextEncoder().encode("OSLAB_CANARY_V1:");

function decodeFlags(pte: bigint): Sv39PteFlags {
  const f = Number(pte & 0x3ffn);
  return {
    v: (f & 0x01) !== 0,
    r: (f & 0x02) !== 0,
    w: (f & 0x04) !== 0,
    x: (f & 0x08) !== 0,
    u: (f & 0x10) !== 0,
    g: (f & 0x20) !== 0,
    a: (f & 0x40) !== 0,
    d: (f & 0x80) !== 0,
    rsw: (f >> 8) & 0x3,
  };
}

function makeEntry(slotIndex: number, tablePa: number, pte: bigint): Sv39Entry {
  const ppn = Number((pte >> 10n) & PPN_MASK);
  const pa = ppn * PAGE_SIZE;
  return {
    slotIndex,
    tablePaHex: `0x${tablePa.toString(16)}`,
    rawHex: `0x${pte.toString(16).padStart(16, "0")}`,
    ppn,
    paHex: `0x${pa.toString(16)}`,
    flags: decodeFlags(pte),
  };
}

function formatBytesPreview(u8: Uint8Array, offset: number, len = 64): { hex: string; ascii: string } {
  if (offset < 0 || offset + len > u8.length) {
    return { hex: "", ascii: "" };
  }
  const slice = u8.subarray(offset, offset + len);
  const hexParts: string[] = [];
  let ascii = "";
  let lastNonZero = -1;
  for (let i = 0; i < slice.length; i++) {
    if (slice[i] !== 0) lastNonZero = i;
  }
  const showLen = Math.max(16, Math.min(len, (Math.floor(lastNonZero / 16) + 1) * 16));
  for (let i = 0; i < showLen; i++) {
    const b = slice[i]!;
    hexParts.push(b.toString(16).padStart(2, "0"));
    ascii += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : ".";
  }
  return { hex: hexParts.join(" "), ascii };
}

function matchBytesAt(u8: Uint8Array, off: number, needle: Uint8Array): boolean {
  if (off < 0 || off + needle.length > u8.length) return false;
  for (let i = 0; i < needle.length; i++) {
    if (u8[off + i] !== needle[i]) return false;
  }
  return true;
}

export class KernelMemoryIntrospector {
  #calibrated = false;
  #physBaseOffset = 0;
  #calibrationNote = "Waiting for canary calibration...";
  #pgdByPid = new Map<number, number>();
  #prevWalks = new Map<string, Sv39WalkResult>();
  #recentSplits: IntrospectionReport["recentSplits"] = [];

  reset(): void {
    this.#calibrated = false;
    this.#physBaseOffset = 0;
    this.#calibrationNote = "Waiting for canary calibration...";
    this.#pgdByPid.clear();
    this.#prevWalks.clear();
    this.#recentSplits = [];
  }

  #readTotalForks(kernel: Kernel): number | null {
    const g = kernel.exports?.total_forks;
    if (!(g instanceof WebAssembly.Global)) return null;
    const addr = Number(g.value);
    const dv = kernel.dv();
    if (addr <= 0 || addr + 4 > dv.byteLength) return null;
    return dv.getUint32(addr, true);
  }

  #calibratePhysBase(kernel: Kernel, canaryPfn: number): void {
    if (this.#calibrated || canaryPfn <= 0) return;
    const u8 = kernel.u8();
    const directOff = canaryPfn * PAGE_SIZE;

    if (matchBytesAt(u8, directOff, CANARY_PREFIX)) {
      this.#calibrated = true;
      this.#physBaseOffset = 0;
      this.#calibrationNote = `Direct physical->Wasm mapping verified via canary PFN 0x${canaryPfn.toString(16)} (offset = 0x0)`;
      return;
    }

    // Fallback scan on 4 KiB page boundaries if kernel has a non-zero phys base
    const totalPages = Math.floor(u8.length / PAGE_SIZE);
    for (let p = 0; p < totalPages; p++) {
      const off = p * PAGE_SIZE;
      if (matchBytesAt(u8, off, CANARY_PREFIX)) {
        this.#calibrated = true;
        this.#physBaseOffset = off - directOff;
        this.#calibrationNote = `Calibrated physBaseOffset=0x${this.#physBaseOffset.toString(16)} via canary PFN 0x${canaryPfn.toString(16)}`;
        return;
      }
    }

    this.#calibrationNote = `Canary PFN 0x${canaryPfn.toString(16)} active; using pagemap-backed physical view`;
  }

  #pfnToLinear(pfn: number): number {
    return this.#physBaseOffset + pfn * PAGE_SIZE;
  }

  #linearToPfn(linearOff: number): number {
    return Math.floor((linearOff - this.#physBaseOffset) / PAGE_SIZE);
  }

  #locateProcessPgd(kernel: Kernel, pid: number, canaryVaHex: string, canaryPfn: number): number | null {
    const cached = this.#pgdByPid.get(pid);
    if (cached !== undefined) return cached;
    if (!this.#calibrated || canaryPfn <= 0) return null;

    let va: bigint;
    try {
      va = BigInt(canaryVaHex);
    } catch {
      return null;
    }

    const vpn2 = Number((va >> 30n) & 0x1ffn);
    const vpn1 = Number((va >> 21n) & 0x1ffn);
    const vpn0 = Number((va >> 12n) & 0x1ffn);

    const dv = kernel.dv();
    const totalPages = Math.floor(dv.byteLength / PAGE_SIZE);
    const knownPgds = new Set(this.#pgdByPid.values());

    // Step 1: Find candidate L0 page tables containing leaf PTE for (vpn0 -> canaryPfn)
    const l0Pages: number[] = [];
    const slot0Off = vpn0 * 8;
    for (let p = 16; p < totalPages; p++) {
      const pageOff = p * PAGE_SIZE;
      const pte = dv.getBigUint64(pageOff + slot0Off, true);
      if ((pte & 1n) === 0n) continue;
      if ((pte & 0xen) === 0n) continue; // must be leaf (R/W/X != 0)
      const ppn = Number((pte >> 10n) & PPN_MASK);
      if (ppn === canaryPfn) {
        l0Pages.push(pageOff);
      }
    }
    if (l0Pages.length === 0) return null;

    // Step 2: Trace up to L1 (PMD) then L2 (PGD)
    const l0PfnSet = new Set(l0Pages.map((off) => this.#linearToPfn(off)));
    const l1Pages: number[] = [];
    const slot1Off = vpn1 * 8;
    for (let p = 16; p < totalPages; p++) {
      const pageOff = p * PAGE_SIZE;
      const pte = dv.getBigUint64(pageOff + slot1Off, true);
      if ((pte & 1n) === 0n) continue;
      if ((pte & 0xen) !== 0n) continue; // non-leaf pointer
      const ppn = Number((pte >> 10n) & PPN_MASK);
      if (l0PfnSet.has(ppn)) {
        l1Pages.push(pageOff);
      }
    }
    if (l1Pages.length === 0) return null;

    const l1PfnSet = new Set(l1Pages.map((off) => this.#linearToPfn(off)));
    const slot2Off = vpn2 * 8;
    const swapperPgd =
      kernel.exports?.swapper_pg_dir instanceof WebAssembly.Global
        ? Number(kernel.exports.swapper_pg_dir.value)
        : -1;

    for (let p = 16; p < totalPages; p++) {
      const pageOff = p * PAGE_SIZE;
      if (pageOff === swapperPgd || knownPgds.has(pageOff)) continue;
      const pte = dv.getBigUint64(pageOff + slot2Off, true);
      if ((pte & 1n) === 0n) continue;
      if ((pte & 0xen) !== 0n) continue;
      const ppn = Number((pte >> 10n) & PPN_MASK);
      if (l1PfnSet.has(ppn)) {
        this.#pgdByPid.set(pid, pageOff);
        return pageOff;
      }
    }
    return null;
  }

  #walkSv39(
    kernel: Kernel,
    pgdLinear: number,
    va: bigint
  ): { l2: Sv39Entry | null; l1: Sv39Entry | null; l0: Sv39Entry | null } {
    const dv = kernel.dv();
    const vpn2 = Number((va >> 30n) & 0x1ffn);
    const vpn1 = Number((va >> 21n) & 0x1ffn);
    const vpn0 = Number((va >> 12n) & 0x1ffn);

    if (pgdLinear < 0 || pgdLinear + PAGE_SIZE > dv.byteLength) {
      return { l2: null, l1: null, l0: null };
    }

    const pte2 = dv.getBigUint64(pgdLinear + vpn2 * 8, true);
    const l2 = makeEntry(vpn2, pgdLinear, pte2);
    if (!l2.flags.v) return { l2, l1: null, l0: null };
    if (l2.flags.r || l2.flags.w || l2.flags.x) {
      return { l2, l1: null, l0: null };
    }

    const l1Linear = this.#pfnToLinear(l2.ppn);
    if (l1Linear < 0 || l1Linear + PAGE_SIZE > dv.byteLength) {
      return { l2, l1: null, l0: null };
    }
    const pte1 = dv.getBigUint64(l1Linear + vpn1 * 8, true);
    const l1 = makeEntry(vpn1, l1Linear, pte1);
    if (!l1.flags.v) return { l2, l1, l0: null };
    if (l1.flags.r || l1.flags.w || l1.flags.x) {
      return { l2, l1, l0: null };
    }

    const l0Linear = this.#pfnToLinear(l1.ppn);
    if (l0Linear < 0 || l0Linear + PAGE_SIZE > dv.byteLength) {
      return { l2, l1, l0: null };
    }
    const pte0 = dv.getBigUint64(l0Linear + vpn0 * 8, true);
    const l0 = makeEntry(vpn0, l0Linear, pte0);
    return { l2, l1, l0 };
  }

  inspect(kernel: Kernel | null, snap: GuestSnapshot): IntrospectionReport {
    if (!kernel) {
      return {
        calibrated: false,
        physBaseOffset: 0,
        calibrationNote: "Kernel offline",
        totalForks: null,
        pgdByPid: {},
        walks: [],
        walksByKey: new Map(),
        frames: [],
        recentSplits: this.#recentSplits,
      };
    }

    const totalForks = this.#readTotalForks(kernel);
    this.#calibratePhysBase(kernel, snap.canaryPfn);

    // Locate Sv39 PGD for parent & alive children
    const activePids = [snap.parentPid];
    for (const c of snap.children) {
      if (c.alive) activePids.push(c.pid);
    }

    // Prune dead PIDs from PGD cache
    const aliveSet = new Set(activePids);
    for (const pid of this.#pgdByPid.keys()) {
      if (!aliveSet.has(pid)) this.#pgdByPid.delete(pid);
    }

    for (const pid of activePids) {
      const cPfn = snap.canaryByPid[String(pid)] ?? snap.canaryPfn;
      if (cPfn > 0) {
        this.#locateProcessPgd(kernel, pid, snap.canaryVa, cPfn);
      }
    }

    const u8 = kernel.u8();
    const walks: Sv39WalkResult[] = [];
    const walksByKey = new Map<string, Sv39WalkResult>();
    const pfnRefs = new Map<number, CowPhysicalFrame>();

    // First pass: walk each page for each active PID
    for (const reg of snap.regionPages) {
      for (const pidStr of Object.keys(reg.byPid)) {
        const pid = Number(pidStr);
        if (!aliveSet.has(pid)) continue;
        const entries = reg.byPid[pidStr] ?? [];
        const pgdLinear = this.#pgdByPid.get(pid) ?? null;

        for (let pageIdx = 0; pageIdx < entries.length; pageIdx++) {
          const pm = entries[pageIdx]!;
          const va = BigInt(pm.va);
          const vpn2 = Number((va >> 30n) & 0x1ffn);
          const vpn1 = Number((va >> 21n) & 0x1ffn);
          const vpn0 = Number((va >> 12n) & 0x1ffn);
          const offset = Number(va & 0xfffn);

          let l2: Sv39Entry | null = null;
          let l1: Sv39Entry | null = null;
          let l0: Sv39Entry | null = null;

          if (pgdLinear !== null) {
            const w = this.#walkSv39(kernel, pgdLinear, va);
            l2 = w.l2;
            l1 = w.l1;
            l0 = w.l0;
          }

          const pfn = l0?.flags.v ? l0.ppn : pm.present ? pm.pfn : null;
          let physHex = "";
          let physAscii = "";
          if (pfn !== null && pfn > 0 && this.#calibrated) {
            const preview = formatBytesPreview(u8, this.#pfnToLinear(pfn), 64);
            physHex = preview.hex;
            physAscii = preview.ascii;
          }

          const key = `${pid}:${reg.regionId}:${pageIdx}`;
          walks.push({
            key,
            pid,
            regionId: reg.regionId,
            regionName: reg.name,
            pageIdx,
            vaHex: pm.va,
            vpn2,
            vpn1,
            vpn0,
            offset,
            pgdAddr: pgdLinear,
            l2,
            l1,
            l0,
            pfn,
            pagemapPresent: pm.present,
            pagemapRawHex: pm.rawHex,
            status: "lazy-unmapped",
            physAscii,
            physHex,
            changedSincePrev: false,
          });
        }
      }
    }

    // Group PFN references to identify shared CoW pages reliably
    const pfnPidCount = new Map<number, Set<number>>();
    for (const w of walks) {
      if (w.pfn !== null && w.pfn > 0) {
        let s = pfnPidCount.get(w.pfn);
        if (!s) {
          s = new Set();
          pfnPidCount.set(w.pfn, s);
        }
        s.add(w.pid);
      }
    }

    const regMetaById = new Map(snap.regions.map((r) => [r.id, r]));

    // Second pass: determine semantic status & detect diffs / CoW splits
    for (const w of walks) {
      const regMeta = regMetaById.get(w.regionId);
      const isSharedMap = regMeta?.shared ?? false;
      const pfnRefPids = w.pfn ? (pfnPidCount.get(w.pfn)?.size ?? 0) : 0;

      let status: PageMappingStatus = "lazy-unmapped";
      if (w.pfn !== null && w.pfn > 0) {
        if (isSharedMap) {
          status = "shared-rw";
        } else if (w.l0?.flags.v) {
          if (!w.l0.flags.w) {
            status = pfnRefPids > 1 ? "cow-shared-ro" : "mapped-ro";
          } else {
            status = "mapped-rw";
          }
        } else {
          status = pfnRefPids > 1 ? "cow-shared-ro" : "mapped-rw";
        }
      }
      w.status = status;

      const prev = this.#prevWalks.get(w.key);
      if (prev) {
        if (prev.pfn === null && w.pfn !== null) {
          w.changedSincePrev = true;
          w.changeReason = `Demand fault allocated PFN 0x${w.pfn.toString(16)}`;
        } else if (prev.pfn !== null && w.pfn !== null && prev.pfn !== w.pfn) {
          w.changedSincePrev = true;
          w.changeReason = `CoW split: PFN 0x${prev.pfn.toString(16)} → 0x${w.pfn.toString(16)}`;
          this.#recentSplits.unshift({
            key: w.key,
            pid: w.pid,
            vaHex: w.vaHex,
            oldPfn: prev.pfn,
            newPfn: w.pfn,
          });
          if (this.#recentSplits.length > 12) this.#recentSplits.length = 12;
        } else if (prev.status !== w.status) {
          w.changedSincePrev = true;
          w.changeReason = `PTE flags: ${prev.status} → ${w.status}`;
        } else if (prev.physHex !== w.physHex) {
          w.changedSincePrev = true;
          w.changeReason = "Physical page bytes updated";
        }
      } else if (w.pfn !== null) {
        w.changedSincePrev = true;
        w.changeReason = "New mapping observed";
      }

      walksByKey.set(w.key, w);

      if (w.pfn !== null && w.pfn > 0) {
        let frame = pfnRefs.get(w.pfn);
        if (!frame) {
          const splitHit = this.#recentSplits.find((s) => s.newPfn === w.pfn);
          frame = {
            pfn: w.pfn,
            paHex: `0x${(w.pfn * PAGE_SIZE).toString(16)}`,
            refs: [],
            isSharedCow: false,
            hexPreview: w.physHex,
            asciiPreview: w.physAscii,
            justSplitFromPfn: splitHit?.oldPfn,
          };
          pfnRefs.set(w.pfn, frame);
        }
        frame.refs.push({
          pid: w.pid,
          isParent: w.pid === snap.parentPid,
          regionId: w.regionId,
          regionName: w.regionName,
          pageIdx: w.pageIdx,
          vaHex: w.vaHex,
          writable: w.l0?.flags.v ? w.l0.flags.w : status !== "cow-shared-ro" && status !== "mapped-ro",
          dirty: w.l0?.flags.d ?? false,
          status: w.status,
        });
      }
    }

    const frames = [...pfnRefs.values()].sort((a, b) => a.pfn - b.pfn);
    for (const f of frames) {
      const uniquePids = new Set(f.refs.map((r) => r.pid));
      f.isSharedCow = uniquePids.size > 1;
    }

    this.#prevWalks = walksByKey;
    const pgdByPidObj: Record<number, number> = {};
    for (const [k, v] of this.#pgdByPid) pgdByPidObj[k] = v;

    return {
      calibrated: this.#calibrated,
      physBaseOffset: this.#physBaseOffset,
      calibrationNote: this.#calibrationNote,
      totalForks,
      pgdByPid: pgdByPidObj,
      walks,
      walksByKey,
      frames,
      recentSplits: this.#recentSplits,
    };
  }
}
