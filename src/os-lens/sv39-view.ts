import type {
  GuestSnapshot,
  IntrospectionReport,
  PageMappingStatus,
  Sv39Entry,
  Sv39WalkResult,
} from "./types";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function statusBadge(status: PageMappingStatus): { label: string; cls: string } {
  switch (status) {
    case "lazy-unmapped":
      return { label: "Lazy VMA (PTE V=0 未分配)", cls: "pte-lazy" };
    case "cow-shared-ro":
      return { label: "CoW 共享只读 (W=0)", cls: "pte-cow" };
    case "mapped-rw":
      return { label: "私有可写 (R/W)", cls: "pte-rw" };
    case "mapped-ro":
      return { label: "只读 (R/O)", cls: "pte-ro" };
    case "shared-rw":
      return { label: "MAP_SHARED 共享可写", cls: "pte-shared" };
  }
}

function renderFlags(entry: Sv39Entry | null): string {
  if (!entry) return `<span class="flag flag-off">unallocated</span>`;
  const f = entry.flags;
  const bits: Array<[string, boolean]> = [
    ["V", f.v],
    ["R", f.r],
    ["W", f.w],
    ["X", f.x],
    ["U", f.u],
    ["A", f.a],
    ["D", f.d],
  ];
  return bits
    .map(([k, on]) => {
      let extra = "";
      if (k === "W" && f.v && !on && !f.r) extra = "";
      if (k === "W" && f.v && f.r && !on) extra = " flag-cow-ro";
      return `<span class="flag ${on ? "flag-on" : "flag-off"}${extra}">${k}:${on ? 1 : 0}</span>`;
    })
    .join("");
}

function renderWalkColumn(walk: Sv39WalkResult, title: string): string {
  const badge = statusBadge(walk.status);
  const pulse = walk.changedSincePrev ? " is-changed" : "";
  const pfnLabel = walk.pfn ? `PFN 0x${walk.pfn.toString(16)} (PA 0x${(walk.pfn * 4096).toString(16)})` : "NULL (未触发缺页)";

  return `
    <div class="sv39-col${pulse}">
      <div class="sv39-col-head">
        <span><strong>${escapeHtml(title)}</strong> · PID ${walk.pid}</span>
        <span class="pte-pill ${badge.cls}">${badge.label}</span>
      </div>
      ${walk.changeReason ? `<div class="sv39-diff-note">⚡ ${escapeHtml(walk.changeReason)}</div>` : ""}
      <div class="sv39-chain">
        <div class="sv39-node ${walk.pgdAddr ? "is-active" : "is-dim"}">
          <div class="node-title">L2 · PGD (Root)</div>
          <div class="node-sub mono">${walk.pgdAddr ? `PGD @ 0x${walk.pgdAddr.toString(16)}` : "Pagemap Fallback"} · slot[${walk.vpn2}]</div>
          ${
            walk.l2
              ? `<div class="node-raw mono">${walk.l2.rawHex} → PPN 0x${walk.l2.ppn.toString(16)}</div>
                 <div class="flag-row">${renderFlags(walk.l2)}</div>`
              : `<div class="node-raw muted">V=0 / 由 /proc/pagemap 校验</div>`
          }
        </div>

        <div class="sv39-arrow">↓ VPN[1]=${walk.vpn1}</div>

        <div class="sv39-node ${walk.l1?.flags.v ? "is-active" : "is-dim"}">
          <div class="node-title">L1 · PMD</div>
          <div class="node-sub mono">${walk.l1 ? `${walk.l1.tablePaHex} · slot[${walk.vpn1}]` : `slot[${walk.vpn1}]`}</div>
          ${
            walk.l1
              ? `<div class="node-raw mono">${walk.l1.rawHex} → PPN 0x${walk.l1.ppn.toString(16)}</div>
                 <div class="flag-row">${renderFlags(walk.l1)}</div>`
              : `<div class="node-raw muted">—</div>`
          }
        </div>

        <div class="sv39-arrow">↓ VPN[0]=${walk.vpn0}</div>

        <div class="sv39-node ${walk.pfn ? (walk.status === "cow-shared-ro" ? "is-cow" : "is-leaf") : "is-empty"}">
          <div class="node-title">L0 · PTE (Leaf 4 KiB)</div>
          <div class="node-sub mono">${walk.l0 ? `${walk.l0.tablePaHex} · slot[${walk.vpn0}]` : `slot[${walk.vpn0}]`}</div>
          ${
            walk.l0
              ? `<div class="node-raw mono">${walk.l0.rawHex}</div>
                 <div class="flag-row">${renderFlags(walk.l0)}</div>`
              : `<div class="node-raw mono">${walk.pagemapRawHex}</div>`
          }
        </div>

        <div class="sv39-arrow">↓ Offset=0x${walk.offset.toString(16).padStart(3, "0")}</div>

        <div class="sv39-phys ${walk.pfn ? (walk.status === "cow-shared-ro" ? "is-cow" : "is-mapped") : "is-null"}">
          <div class="node-title">物理页帧 (4 KiB Frame)</div>
          <div class="mono">${pfnLabel}</div>
          ${walk.physAscii ? `<div class="phys-preview mono">RAM: "${escapeHtml(walk.physAscii.replace(/\.+$/, "") || "<zeros>")}"</div>` : ""}
        </div>
      </div>
    </div>
  `;
}

export class Sv39View {
  readonly #root: HTMLElement;
  #selectedRegionId: number | null = null;
  #selectedPageIdx = 0;
  #selectedChildPid: number | null = null;

  constructor(root: HTMLElement) {
    this.#root = root;
  }

  selectRegion(regionId: number, pageIdx = 0): void {
    this.#selectedRegionId = regionId;
    this.#selectedPageIdx = pageIdx;
  }

  selectComparePid(pid: number): void {
    this.#selectedChildPid = pid;
  }

  render(snap: GuestSnapshot | null, report: IntrospectionReport | null): void {
    if (!snap || !report) {
      this.#root.innerHTML = `<div class="empty-hint">等待 Linux 启动与 <code>oslab</code> 就绪...</div>`;
      return;
    }

    if (snap.regions.length === 0) {
      this.#root.innerHTML = `
        <div class="sv39-calibration mono">${escapeHtml(report.calibrationNote)} | total_forks=${report.totalForks ?? "-"}</div>
        <div class="empty-hint">
          尚未创建教学映射区域。在左侧终端输入 <code>mmap()</code> 或点击上方 <strong>1. mmap() 懒分配</strong>，即可实时透视 Sv39 三级页表。
        </div>
      `;
      return;
    }

    // Pick valid selected region & page
    let reg = snap.regions.find((r) => r.id === this.#selectedRegionId) ?? snap.regions[snap.regions.length - 1]!;
    this.#selectedRegionId = reg.id;
    if (this.#selectedPageIdx >= reg.pages) this.#selectedPageIdx = 0;

    const parentKey = `${snap.parentPid}:${reg.id}:${this.#selectedPageIdx}`;
    const parentWalk = report.walksByKey.get(parentKey);

    const aliveChildren = snap.children.filter((c) => c.alive);
    const compareChild =
      aliveChildren.find((c) => c.pid === this.#selectedChildPid) ??
      aliveChildren[aliveChildren.length - 1] ??
      null;
    const childWalk = compareChild
      ? report.walksByKey.get(`${compareChild.pid}:${reg.id}:${this.#selectedPageIdx}`)
      : undefined;

    const vaBig = BigInt(parentWalk?.vaHex ?? reg.addrHex);
    const vpn2 = Number((vaBig >> 30n) & 0x1ffn);
    const vpn1 = Number((vaBig >> 21n) & 0x1ffn);
    const vpn0 = Number((vaBig >> 12n) & 0x1ffn);
    const offset = Number(vaBig & 0xfffn);

    const regionOptions = snap.regions
      .map(
        (r) =>
          `<option value="${r.id}" ${r.id === reg.id ? "selected" : ""}>${r.name} (${r.addrHex}, ${r.pages}p, ${r.prot})</option>`
      )
      .join("");

    const pageTabs = Array.from({ length: reg.pages }, (_, i) => {
      const w = report.walksByKey.get(`${snap.parentPid}:${reg.id}:${i}`);
      const dot = w?.pfn ? (w.status === "cow-shared-ro" ? "dot-cow" : "dot-ok") : "dot-lazy";
      return `<button class="page-pill ${i === this.#selectedPageIdx ? "is-active" : ""}" data-page="${i}"><i class="${dot}"></i>p${i}</button>`;
    }).join("");

    const childOptions =
      aliveChildren.length > 0
        ? `<label class="inline-select">对比子进程
            <select id="sv39-child-select">
              ${aliveChildren
                .map(
                  (c) =>
                    `<option value="${c.pid}" ${c.pid === compareChild?.pid ? "selected" : ""}>PID ${c.pid} (${escapeHtml(c.status)})</option>`
                )
                .join("")}
            </select>
          </label>`
        : `<span class="muted mono">暂无活跃子进程（可执行 <code>fork()</code> 观察双页表对比）</span>`;

    this.#root.innerHTML = `
      <div class="sv39-toolbar">
        <label class="inline-select">区域
          <select id="sv39-region-select">${regionOptions}</select>
        </label>
        <div class="page-pills">${pageTabs}</div>
        ${childOptions}
      </div>

      <div class="sv39-va-bar mono">
        <span class="va-label">Sv39 39-bit VA: <strong>${parentWalk?.vaHex ?? reg.addrHex}</strong></span>
        <div class="va-bits">
          <span class="bit-seg seg-vpn2" title="L2 Index (bits 38..30)">VPN[2]=${vpn2} (0x${vpn2.toString(16)})</span>
          <span class="bit-seg seg-vpn1" title="L1 Index (bits 29..21)">VPN[1]=${vpn1} (0x${vpn1.toString(16)})</span>
          <span class="bit-seg seg-vpn0" title="L0 Index (bits 20..12)">VPN[0]=${vpn0} (0x${vpn0.toString(16)})</span>
          <span class="bit-seg seg-off" title="Page Offset (bits 11..0)">Off=0x${offset.toString(16).padStart(3, "0")}</span>
        </div>
      </div>

      <div class="sv39-columns ${childWalk ? "is-dual" : "is-single"}">
        ${parentWalk ? renderWalkColumn(parentWalk, "父进程 Parent") : ""}
        ${childWalk ? renderWalkColumn(childWalk, "子进程 Child") : ""}
      </div>

      <div class="sv39-calibration mono">
        <span>${escapeHtml(report.calibrationNote)}</span>
        <span>total_forks=${report.totalForks ?? "-"} | pgfault=${snap.vmstat.pgfault}</span>
      </div>
    `;

    this.#root.querySelector<HTMLSelectElement>("#sv39-region-select")?.addEventListener("change", (e) => {
      this.#selectedRegionId = Number((e.target as HTMLSelectElement).value);
      this.#selectedPageIdx = 0;
      this.render(snap, report);
    });

    for (const btn of this.#root.querySelectorAll<HTMLButtonElement>(".page-pill")) {
      btn.addEventListener("click", () => {
        this.#selectedPageIdx = Number(btn.dataset.page);
        this.render(snap, report);
      });
    }

    this.#root.querySelector<HTMLSelectElement>("#sv39-child-select")?.addEventListener("change", (e) => {
      this.#selectedChildPid = Number((e.target as HTMLSelectElement).value);
      this.render(snap, report);
    });
  }
}
