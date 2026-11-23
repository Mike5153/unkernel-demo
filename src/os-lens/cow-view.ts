import type { GuestSnapshot, IntrospectionReport } from "./types";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export class CowView {
  readonly #root: HTMLElement;

  constructor(root: HTMLElement) {
    this.#root = root;
  }

  render(snap: GuestSnapshot | null, report: IntrospectionReport | null): void {
    if (!snap || !report) {
      this.#root.innerHTML = `<div class="empty-hint">等待观测物理页帧...</div>`;
      return;
    }

    const splitBanners = report.recentSplits
      .slice(0, 3)
      .map(
        (s) =>
          `<div class="cow-split-banner mono">✂️ CoW 物理页分裂: PID ${s.pid} (${s.vaHex}) — <code>PFN 0x${s.oldPfn.toString(16)}</code> ➔ <code>PFN 0x${s.newPfn.toString(16)}</code></div>`
      )
      .join("");

    if (report.frames.length === 0) {
      this.#root.innerHTML = `
        ${splitBanners}
        <div class="empty-hint">
          当前尚无已提交物理页帧（<code>mmap()</code> 默认懒分配，首次 <code>read</code>/<code>write</code> 触发缺页中断后将在此显示真实 4 KiB 物理页与字节内容）。
        </div>
      `;
      return;
    }

    const cards = report.frames
      .map((frame) => {
        const refBadges = frame.refs
          .map((r) => {
            const role = r.isParent ? "Parent" : "Child";
            const perm = r.writable ? "RW" : "RO(CoW)";
            const cls = r.writable ? "ref-rw" : "ref-cow";
            return `
              <div class="cow-ref ${cls} mono">
                <span>${role} PID ${r.pid} · ${r.regionName}[${r.pageIdx}] (${r.vaHex})</span>
                <span class="ref-perm">${perm}${r.dirty ? " · Dirty" : ""}</span>
              </div>
            `;
          })
          .join("");

        const cardCls = frame.isSharedCow
          ? "is-shared-cow"
          : frame.justSplitFromPfn
            ? "is-just-split"
            : "";

        const headTag = frame.isSharedCow
          ? `<span class="cow-tag cow-tag-warn">共享只读 ×${new Set(frame.refs.map((r) => r.pid)).size} (CoW Armed)</span>`
          : frame.justSplitFromPfn
            ? `<span class="cow-tag cow-tag-split">从 PFN 0x${frame.justSplitFromPfn.toString(16)} 分裂而来</span>`
            : `<span class="cow-tag cow-tag-ok">独占物理页</span>`;

        return `
          <div class="cow-frame-card ${cardCls}">
            <div class="cow-frame-head">
              <strong class="mono">PFN 0x${frame.pfn.toString(16)} <span class="muted">(${frame.paHex})</span></strong>
              ${headTag}
            </div>
            <div class="cow-ref-list">${refBadges}</div>
            <div class="cow-ram-box mono">
              <div class="ram-ascii">ASCII: <span>${escapeHtml(frame.asciiPreview || "<zeros>")}</span></div>
              <div class="ram-hex">${escapeHtml(frame.hexPreview.slice(0, 95))}${frame.hexPreview.length > 95 ? " ..." : ""}</div>
            </div>
          </div>
        `;
      })
      .join("");

    this.#root.innerHTML = `
      ${splitBanners}
      <div class="cow-frames-grid">${cards}</div>
    `;
  }
}
