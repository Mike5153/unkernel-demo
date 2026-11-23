export interface ProcNode {
  pid: number;
  ppid: number;
  comm: string;
  state: string;
  cmdline: string;
  vmSizeKb: number;
  vmRssKb: number;
  threads: number;
  minFlt: number;
  majFlt: number;
  children: number[];
  isLab: boolean;
}

export interface VmaInfo {
  start: string;
  end: string;
  perms: string;
  offset: string;
  path: string;
}

export interface PagemapEntry {
  va: string;
  present: boolean;
  swapped: boolean;
  fileAnon: boolean;
  softDirty: boolean;
  pfn: number;
  rawHex: string;
}

export interface MappedRegion {
  id: number;
  name: string;
  addr: number;
  addrHex: string;
  pages: number;
  size: number;
  prot: string;
  protBits: number;
  shared: boolean;
}

export interface RegionPagemap {
  regionId: number;
  name: string;
  addrHex: string;
  pages: number;
  prot: string;
  shared: boolean;
  byPid: Record<string, PagemapEntry[]>;
}

export interface ChildProcess {
  pid: number;
  ppid: number;
  alive: boolean;
  zombie: boolean;
  status: string;
  exitCode: number;
}

export interface VmStatInfo {
  pgfault: number;
  pgmajfault: number;
  nrAnonPages: number;
  nrFreePages: number;
}

export interface LabEvent {
  seq: number;
  kind: string;
  pid: number;
  detail: string;
  va?: string;
  pages?: number;
}

export interface GuestSnapshot {
  parentPid: number;
  canaryVa: string;
  canaryPfn: number;
  canaryByPid: Record<string, number>;
  regions: MappedRegion[];
  regionPages: RegionPagemap[];
  children: ChildProcess[];
  procTree: ProcNode[];
  mapsByPid: Record<string, VmaInfo[]>;
  vmstat: VmStatInfo;
  events: LabEvent[];
}

export interface Sv39PteFlags {
  v: boolean;
  r: boolean;
  w: boolean;
  x: boolean;
  u: boolean;
  g: boolean;
  a: boolean;
  d: boolean;
  rsw: number;
}

export interface Sv39Entry {
  slotIndex: number;
  tablePaHex: string;
  rawHex: string;
  ppn: number;
  paHex: string;
  flags: Sv39PteFlags;
}

export type PageMappingStatus =
  | "lazy-unmapped"
  | "mapped-rw"
  | "cow-shared-ro"
  | "mapped-ro"
  | "shared-rw";

export interface Sv39WalkResult {
  key: string; // `${pid}:${regionId}:${pageIdx}`
  pid: number;
  regionId: number;
  regionName: string;
  pageIdx: number;
  vaHex: string;
  vpn2: number;
  vpn1: number;
  vpn0: number;
  offset: number;
  pgdAddr: number | null;
  l2: Sv39Entry | null;
  l1: Sv39Entry | null;
  l0: Sv39Entry | null;
  pfn: number | null;
  pagemapPresent: boolean;
  pagemapRawHex: string;
  status: PageMappingStatus;
  physAscii: string;
  physHex: string;
  changedSincePrev: boolean;
  changeReason?: string;
}

export interface CowFrameRef {
  pid: number;
  isParent: boolean;
  regionId: number;
  regionName: string;
  pageIdx: number;
  vaHex: string;
  writable: boolean;
  dirty: boolean;
  status: PageMappingStatus;
}

export interface CowPhysicalFrame {
  pfn: number;
  paHex: string;
  refs: CowFrameRef[];
  isSharedCow: boolean;
  hexPreview: string;
  asciiPreview: string;
  justSplitFromPfn?: number;
}

export interface IntrospectionReport {
  calibrated: boolean;
  physBaseOffset: number;
  calibrationNote: string;
  totalForks: number | null;
  pgdByPid: Record<number, number>;
  walks: Sv39WalkResult[];
  walksByKey: Map<string, Sv39WalkResult>;
  frames: CowPhysicalFrame[];
  recentSplits: Array<{
    key: string;
    pid: number;
    vaHex: string;
    oldPfn: number;
    newPfn: number;
  }>;
}
