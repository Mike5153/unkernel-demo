import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

const SLICE_MS = 16;
const SLICE_BYTES = 262144;
const PENDING_INPUT_MAX = 65536;

/** Yield to the browser task queue without setTimeout throttling in background tabs. */
function yieldTask() {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      resolve();
    };
    ch.port2.postMessage(0);
  });
}

function createXterm(paneEl) {
  const term = new Terminal({
    cursorBlink: true,
    scrollback: 5000,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontSize: 13,
    lineHeight: 1.25,
    theme: {
      background: "#070a0e",
      foreground: "#e6edf3",
      cursor: "#3b82f6",
      selectionBackground: "rgba(59, 130, 246, 0.35)",
    },
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.open(paneEl);
  fitAddon.fit();

  // Ctrl+C / Cmd+C copies when text is selected; otherwise sends \x03 (SIGINT).
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type === "keydown" && (ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "c") {
      if (term.hasSelection()) {
        const text = term.getSelection();
        void navigator.clipboard?.writeText(text).catch(() => {});
        term.clearSelection();
        return false;
      }
    }
    return true;
  });

  return { term, fitAddon };
}

export class TerminalManager {
  #tabBar;
  #stage;
  #emptyEl;
  #tabs = new Map();
  #activeId = null;
  #nextPtyNum = 1;
  #ro;
  #fitRaf = 0;

  constructor({ tabBar, stage, emptyEl }) {
    this.#tabBar = tabBar;
    this.#stage = stage;
    this.#emptyEl = emptyEl;

    this.#ro = new ResizeObserver(() => {
      if (this.#fitRaf) cancelAnimationFrame(this.#fitRaf);
      this.#fitRaf = requestAnimationFrame(() => {
        this.#fitRaf = 0;
        for (const tab of this.#tabs.values()) {
          try {
            tab.fitAddon.fit();
          } catch {}
        }
      });
    });
    this.#ro.observe(this.#stage);
  }

  get activeTab() {
    return this.#activeId ? this.#tabs.get(this.#activeId) ?? null : null;
  }

  /** Attach Tab 0 to the kernel console (hvc0). */
  attachConsole(vm, onCtrlC) {
    this.destroyAll();
    this.#emptyEl.style.display = "none";

    const id = "console";
    const paneEl = document.createElement("div");
    paneEl.className = "term-pane";
    this.#stage.appendChild(paneEl);

    const { term, fitAddon } = createXterm(paneEl);
    vm.resize(term.cols, term.rows);

    const dataDisp = term.onData((data) => {
      vm.write(data);
    });
    const resizeDisp = term.onResize(({ cols, rows }) => {
      vm.resize(cols, rows);
    });

    const tab = {
      id,
      title: "console (hvc0)",
      closable: false,
      kind: "console",
      paneEl,
      term,
      fitAddon,
      write: (text) => term.write(text),
      sendInput: (data) => vm.write(data),
      sendCtrlC: () => {
        if (onCtrlC) onCtrlC();
        vm.write("\x03");
      },
      dispose: () => {
        dataDisp.dispose();
        resizeDisp.dispose();
        term.dispose();
        paneEl.remove();
      },
    };

    this.#tabs.set(id, tab);
    this.#renderTabBar();
    this.activateTab(id);
    return tab;
  }

  /** Open a new interactive PTY tab via vm.spawn(). */
  async openPtyTab(vm, waitForUserspace, opts = {}) {
    if (!vm) return null;
    this.#emptyEl.style.display = "none";

    const num = this.#nextPtyNum++;
    const id = `tty-${num}`;
    const paneEl = document.createElement("div");
    paneEl.className = "term-pane";
    this.#stage.appendChild(paneEl);

    const { term, fitAddon } = createXterm(paneEl);
    let pty = null;
    let closed = false;
    let pending = "";

    const dataDisp = term.onData((data) => {
      if (closed) return;
      if (pty) {
        void pty.write(data).catch(() => {});
      } else if (pending.length < PENDING_INPUT_MAX) {
        pending += data;
      }
    });

    const resizeDisp = term.onResize(({ cols, rows }) => {
      if (pty && !closed) pty.resize(cols, rows);
    });

    const tab = {
      id,
      title: opts.title ?? `tty ${num}`,
      closable: opts.closable ?? true,
      kind: "pty",
      paneEl,
      term,
      fitAddon,
      sendInput: (data) => {
        if (closed) return;
        if (pty) void pty.write(data).catch(() => {});
        else if (pending.length < PENDING_INPUT_MAX) pending += data;
      },
      sendCtrlC: () => {
        if (closed) return;
        if (pty) void pty.write("\x03").catch(() => {});
      },
      dispose: () => {
        closed = true;
        dataDisp.dispose();
        resizeDisp.dispose();
        if (pty) void pty.close().catch(() => {});
        term.dispose();
        paneEl.remove();
      },
    };

    this.#tabs.set(id, tab);
    this.#renderTabBar();
    this.activateTab(id);

    term.write(`\x1b[90mWaiting for kwtty on vsock...\x1b[0m\r\n`);
    try {
      await waitForUserspace();
      if (closed) return tab;

      fitAddon.fit();
      pty = await vm.spawn(opts.file, opts.args, {
        cols: term.cols,
        rows: term.rows,
        term: "xterm-256color",
        detachable: true,
      });

      if (closed) {
        void pty.close().catch(() => {});
        return tab;
      }

      if (pending) {
        const queued = pending;
        pending = "";
        void pty.write(queued).catch(() => {});
      }

      // Continuously drain pty.output (even when tab is hidden) so vsock credit never stalls.
      void this.#pumpPtyOutput(tab, pty, () => closed);

      pty.ended
        .then((end) => {
          if (closed) return;
          const label = end.type === "exit" ? `exit ${end.code}` : end.type;
          term.write(`\r\n\x1b[90m[session ended: ${label}]\x1b[0m\r\n`);
        })
        .catch((err) => {
          if (closed) return;
          term.write(`\r\n\x1b[31m[session error: ${err?.message ?? err}]\x1b[0m\r\n`);
        });
    } catch (err) {
      if (!closed) {
        term.write(`\r\n\x1b[31mFailed to spawn PTY: ${err?.message ?? err}\x1b[0m\r\n`);
      }
    }

    return tab;
  }

  async #pumpPtyOutput(tab, pty, isClosed) {
    const dec = new TextDecoder();
    const reader = pty.output.getReader();
    let sliceStart = performance.now();
    let sliceBytes = 0;

    try {
      while (!isClosed()) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = dec.decode(value, { stream: true });
        if (text) tab.term.write(text);

        sliceBytes += value.byteLength;
        if (sliceBytes >= SLICE_BYTES || performance.now() - sliceStart >= SLICE_MS) {
          await yieldTask();
          sliceStart = performance.now();
          sliceBytes = 0;
        }
      }
      const tail = dec.decode();
      if (tail && !isClosed()) tab.term.write(tail);
    } catch {
      // Errors are surfaced via pty.ended.
    } finally {
      reader.releaseLock();
    }
  }

  activateTab(id) {
    const target = this.#tabs.get(id);
    if (!target) return;
    this.#activeId = id;

    for (const tab of this.#tabs.values()) {
      const active = tab.id === id;
      tab.paneEl.classList.toggle("is-hidden", !active);
    }

    this.#renderTabBar();
    target.fitAddon.fit();
    target.term.focus();
  }

  closeTab(id) {
    const tab = this.#tabs.get(id);
    if (!tab || !tab.closable) return;

    const ids = [...this.#tabs.keys()];
    const idx = ids.indexOf(id);
    tab.dispose();
    this.#tabs.delete(id);

    if (this.#activeId === id) {
      const fallback = ids[idx - 1] ?? ids[idx + 1] ?? null;
      this.#activeId = null;
      if (fallback && this.#tabs.has(fallback)) {
        this.activateTab(fallback);
      }
    } else {
      this.#renderTabBar();
    }
  }

  sendToActive(data) {
    const tab = this.activeTab;
    if (!tab) return;
    tab.sendInput(data);
    tab.term.focus();
  }

  sendCtrlC() {
    const tab = this.activeTab;
    if (!tab) return;
    tab.sendCtrlC();
    tab.term.focus();
  }

  destroyAll() {
    for (const tab of this.#tabs.values()) {
      tab.dispose();
    }
    this.#tabs.clear();
    this.#activeId = null;
    this.#nextPtyNum = 1;
    this.#renderTabBar();
    this.#emptyEl.style.display = "flex";
  }

  #renderTabBar() {
    this.#tabBar.innerHTML = "";
    for (const tab of this.#tabs.values()) {
      const btn = document.createElement("div");
      btn.className = `tab-btn${tab.id === this.#activeId ? " is-active" : ""}`;
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-selected", String(tab.id === this.#activeId));

      const label = document.createElement("span");
      label.textContent = tab.title;
      btn.appendChild(label);

      btn.addEventListener("click", () => this.activateTab(tab.id));

      if (tab.closable) {
        const close = document.createElement("button");
        close.className = "tab-close";
        close.type = "button";
        close.title = `Close ${tab.title}`;
        close.textContent = "×";
        close.addEventListener("click", (e) => {
          e.stopPropagation();
          this.closeTab(tab.id);
        });
        btn.appendChild(close);
      }

      this.#tabBar.appendChild(btn);
    }
  }
}
