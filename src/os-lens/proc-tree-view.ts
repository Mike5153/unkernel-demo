import type { GuestSnapshot, ProcNode } from "./types";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function stateBadge(state: string): { label: string; cls: string } {
  switch (state) {
    case "R":
      return { label: "R (Running)", cls: "st-run" };
    case "S":
      return { label: "S (Sleeping)", cls: "st-sleep" };
    case "Z":
      return { label: "Z (Zombie)", cls: "st-zombie" };
    case "D":
      return { label: "D (Disk)", cls: "st-warn" };
    default:
      return { label: state, cls: "st-sleep" };
  }
}

export class ProcTreeView {
  readonly #root: HTMLElement;
  #selectedPid: number | null = null;
  #onSelectPid?: (pid: number) => void;

  constructor(root: HTMLElement, onSelectPid?: (pid: number) => void) {
    this.#root = root;
    this.#onSelectPid = onSelectPid;
  }

  setSelectedPid(pid: number): void {
    this.#selectedPid = pid;
  }

  render(snap: GuestSnapshot | null): void {
    if (!snap) {
      this.#root.innerHTML = `<div class="empty-hint">等待采集 <code>/proc</code> 进程树...</div>`;
      return;
    }

    const byPid = new Map<number, ProcNode>();
    for (const p of snap.procTree) byPid.set(p.pid, p);

    if (this.#selectedPid === null || !byPid.has(this.#selectedPid)) {
      this.#selectedPid = snap.parentPid;
    }

    const roots = snap.procTree.filter((p) => p.ppid === 0 || !byPid.has(p.ppid));
    const lines: string[] = [];

    const walkTree = (node: ProcNode, depth: number) => {
      const sb = stateBadge(node.state);
      const selected = node.pid === this.#selectedPid ? " is-selected" : "";
      const labTag = node.isLab
        ? node.pid === snap.parentPid
          ? `<span class="proc-tag tag-parent">oslab Parent</span>`
          : `<span class="proc-tag tag-child">CoW Child</span>`
        : "";
      lines.push(`
        <div class="proc-row${selected}" data-pid="${node.pid}" style="padding-left:${8 + depth * 18}px">
          <div class="proc-left">
            <span class="proc-branch">${depth > 0 ? "└─" : "•"}</span>
            <strong class="mono">PID ${node.pid}</strong>
            <span class="proc-comm mono">${escapeHtml(node.comm)}</span>
            ${labTag}
          </div>
          <div class="proc-right mono">
            <span class="proc-state ${sb.cls}">${sb.label}</span>
            <span>RSS ${node.vmRssKb}K</span>
            <span title="Minor / Major Page Faults">flt ${node.minFlt}/${node.majFlt}</span>
          </div>
        </div>
      `);
      for (const cid of node.children) {
        const child = byPid.get(cid);
        if (child) walkTree(child, depth + 1);
      }
    };

    for (const r of roots) walkTree(r, 0);

    const maps = snap.mapsByPid[String(this.#selectedPid)] ?? [];
    const labAddrs = new Set(snap.regions.map((r) => r.addrHex.toLowerCase()));
    const highlightedMaps = maps
      .filter((m) => labAddrs.has(m.start.toLowerCase()) || m.path === "[heap]" || m.path === "[stack]" || m.path.includes("oslab"))
      .slice(0, 12);
    const displayMaps = highlightedMaps.length > 0 ? highlightedMaps : maps.slice(0, 10);

    const vmaRows =
      displayMaps.length > 0
        ? displayMaps
            .map((m) => {
              const isLabVma = labAddrs.has(m.start.toLowerCase());
              return `<div class="vma-row mono ${isLabVma ? "is-lab-vma" : ""}">
                <span>${m.start}–${m.end}</span>
                <span class="vma-perm">${m.perms}</span>
                <span class="vma-path">${escapeHtml(m.path)}</span>
              </div>`;
            })
            .join("")
        : `<div class="muted mono">该进程当前无可读 VMA（可能处于 Zombie 状态）</div>`;

    this.#root.innerHTML = `
      <div class="proc-tree-list">${lines.join("")}</div>
      <div class="vma-box">
        <div class="vma-head mono">
          <span><strong>/proc/${this.#selectedPid}/maps</strong> (关键 VMA 视图)</span>
          <span class="muted">共 ${maps.length} 个 VMA</span>
        </div>
        <div class="vma-list">${vmaRows}</div>
      </div>
    `;

    for (const row of this.#root.querySelectorAll<HTMLElement>(".proc-row")) {
      row.addEventListener("click", () => {
        const pid = Number(row.dataset.pid);
        this.#selectedPid = pid;
        this.#onSelectPid?.(pid);
        this.render(snap);
      });
    }
  }
}
