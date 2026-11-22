import type { ClusterManager } from "../cluster/cluster-manager";
import type { NodeId } from "../cluster/types";
import { TerminalManager } from "../terminal-manager.js";

/**
 * Per-node interactive @xterm/xterm terminal drawer backed by TerminalManager
 * over the node worker's vsock transport (works even when eth0 is severed).
 */
export class TerminalDrawer {
  readonly #cluster: ClusterManager;
  readonly #drawerEl: HTMLElement;
  readonly #titleEl: HTMLElement;
  readonly #terminals: TerminalManager;
  #currentNodeId: NodeId | null = null;
  #unsubConsole: (() => void) | null = null;

  constructor(opts: {
    cluster: ClusterManager;
    drawerEl: HTMLElement;
    titleEl: HTMLElement;
    tabBar: HTMLElement;
    stage: HTMLElement;
    emptyEl: HTMLElement;
    btnNewTab: HTMLButtonElement;
    btnCtrlC: HTMLButtonElement;
    btnClose: HTMLButtonElement;
    quickChips: HTMLButtonElement[];
  }) {
    this.#cluster = opts.cluster;
    this.#drawerEl = opts.drawerEl;
    this.#titleEl = opts.titleEl;
    this.#terminals = new TerminalManager({
      tabBar: opts.tabBar,
      stage: opts.stage,
      emptyEl: opts.emptyEl,
    });

    opts.btnNewTab.addEventListener("click", () => {
      if (!this.#currentNodeId) return;
      const vmProxy = this.#cluster.createVmProxy(this.#currentNodeId);
      void this.#terminals.openPtyTab(vmProxy as any, () => Promise.resolve());
    });

    opts.btnCtrlC.addEventListener("click", () => {
      this.#terminals.sendCtrlC();
    });

    opts.btnClose.addEventListener("click", () => {
      this.close();
    });

    for (const chip of opts.quickChips) {
      chip.addEventListener("click", () => {
        if (!this.#currentNodeId) return;
        this.#terminals.sendToActive(`${chip.dataset.cmd}\r`);
      });
    }
  }

  open(nodeId: NodeId): void {
    const state = this.#cluster.getNodeState(nodeId);
    if (!state || state.lifecycle !== "running") return;

    this.#cleanupCurrent();
    this.#currentNodeId = nodeId;
    this.#titleEl.textContent = `${state.config.label} (${state.config.ip}) — vsock 带外控制终端`;
    this.#drawerEl.classList.add("is-open");

    const vmProxy = this.#cluster.createVmProxy(nodeId);
    const consoleTab = this.#terminals.attachConsole(vmProxy as any);
    const { history, unsubscribe } = this.#cluster.subscribeConsole(nodeId, (text) => {
      consoleTab.write(text);
    });
    if (history) {
      consoleTab.write(history);
    }
    this.#unsubConsole = unsubscribe;

    // Also open an interactive PTY shell tab immediately for running snmp/ip/ps commands.
    void this.#terminals.openPtyTab(vmProxy as any, () => Promise.resolve());
  }

  close(): void {
    this.#cleanupCurrent();
    this.#drawerEl.classList.remove("is-open");
  }

  #cleanupCurrent(): void {
    if (this.#unsubConsole) {
      this.#unsubConsole();
      this.#unsubConsole = null;
    }
    this.#terminals.destroyAll();
    this.#currentNodeId = null;
  }
}
