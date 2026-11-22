import {
  ConsoleRouter,
  MemoryFs,
  checkSupport,
  createKernel,
} from "unkernel";
import { TerminalManager } from "./terminal-manager.js";

const el = {
  supportBadge: document.getElementById("support-badge"),
  vmBadge: document.getElementById("vm-badge"),
  progressBar: document.getElementById("progress-bar"),
  btnBoot: document.getElementById("btn-boot"),
  btnPoweroff: document.getElementById("btn-poweroff"),
  btnStop: document.getElementById("btn-stop"),
  tabBar: document.getElementById("tab-bar"),
  btnNewTab: document.getElementById("btn-new-tab"),
  btnCtrlC: document.getElementById("btn-ctrl-c"),
  terminalStage: document.getElementById("terminal-stage"),
  terminalEmpty: document.getElementById("terminal-empty"),
  execForm: document.getElementById("exec-form"),
  execIn: document.getElementById("exec-in"),
  btnExec: document.getElementById("btn-exec"),
  execOut: document.getElementById("exec-out"),
  memfsFiles: document.getElementById("memfs-files"),
  memfsEvents: document.getElementById("memfs-events"),
  btnHostWrite: document.getElementById("btn-host-write"),
  kernelLogs: document.getElementById("kernel-logs"),
  statsLine: document.getElementById("stats-line"),
  quickChips: [...document.querySelectorAll(".chip")],
};

const terminals = new TerminalManager({
  tabBar: el.tabBar,
  stage: el.terminalStage,
  emptyEl: el.terminalEmpty,
});

let vm = null;
let memFs = null;
let statsTimer = null;
let hostWriteCount = 0;
let userspaceReadyPromise = Promise.resolve();

function setRunningUI(running) {
  el.btnBoot.disabled = running;
  el.btnPoweroff.disabled = !running;
  el.btnStop.disabled = !running;
  el.btnNewTab.disabled = !running;
  el.btnCtrlC.disabled = !running;
  el.execIn.disabled = !running;
  el.btnExec.disabled = !running;
  el.btnHostWrite.disabled = !running;
  for (const chip of el.quickChips) chip.disabled = !running;
}

function setVmBadge(text, tone = "muted") {
  el.vmBadge.textContent = text;
  el.vmBadge.className = `badge badge-${tone}`;
}

function appendLog(pre, text) {
  pre.textContent += text;
  if (pre.textContent.length > 60000) {
    pre.textContent = pre.textContent.slice(-40000);
  }
  pre.scrollTop = pre.scrollHeight;
}

function renderMemFs() {
  if (!memFs) return;
  const entries = memFs.list("/");
  if (!entries.length) {
    el.memfsFiles.innerHTML = `<div class="muted">(empty)</div>`;
    return;
  }
  el.memfsFiles.innerHTML = entries
    .map((name) => {
      const fullPath = `/${name}`;
      const attr = memFs.stat(fullPath);
      const isDir = attr?.type === "dir";
      let preview = "";
      if (!isDir) {
        try {
          preview = memFs.readText(fullPath).replace(/\s+/g, " ").slice(0, 48);
        } catch {
          preview = `${attr?.size ?? 0} bytes`;
        }
      }
      return `<div class="file-item"><span>${isDir ? "📁" : "📄"} ${name}</span><span class="muted">${isDir ? "dir" : preview}</span></div>`;
    })
    .join("");
}

function formatProgress(p) {
  if (p.stage === "download") {
    const mb = (p.loaded / 1048576).toFixed(1);
    const total = p.total ? ` / ${(p.total / 1048576).toFixed(1)} MiB` : "";
    return `Downloading kernel: ${mb}${total}`;
  }
  if (p.stage === "compiled") {
    return `Kernel compiled in ${p.ms.toFixed(0)} ms`;
  }
  if (p.stage === "memory") {
    return `Allocating guest RAM (${p.mib ?? "?"} MiB)...`;
  }
  return `Boot stage: ${p.stage}`;
}

async function initSupportCheck() {
  const report = await checkSupport();
  if (report.ok) {
    el.supportBadge.textContent = "JSPI Ready";
    el.supportBadge.className = "badge badge-ok";
  } else {
    el.supportBadge.textContent = "Unsupported Browser";
    el.supportBadge.className = "badge badge-err";
    el.btnBoot.disabled = true;
    el.progressBar.textContent = `Missing browser support: ${report.problems.join("; ")}. Requires Chrome/Edge 137+, Firefox 153+, or Safari 27+.`;
  }
}

async function boot() {
  if (vm) return;

  el.kernelLogs.textContent = "";
  el.memfsEvents.textContent = "";
  el.execOut.textContent = "Booting...";
  setVmBadge("Booting", "warn");
  el.btnBoot.disabled = true;

  memFs = new MemoryFs({
    "hello.txt": "Hello from the browser host via 9p/vsock!\nTry editing me with: vi /mnt/host/hello.txt\n",
    "now.txt": () => `Host time: ${new Date().toISOString()}\n`,
  });
  renderMemFs();

  memFs.onChange((change) => {
    appendLog(el.memfsEvents, `[guest] ${change.type}: ${change.path}${change.to ? ` -> ${change.to}` : ""}\n`);
    renderMemFs();
  });

  let resolveUserspace;
  userspaceReadyPromise = new Promise((resolve) => {
    resolveUserspace = resolve;
  });

  const t0 = performance.now();
  try {
    vm = await createKernel({
      mounts: {
        "/mnt/host": memFs,
      },
      onProgress: (p) => {
        el.progressBar.textContent = formatProgress(p);
      },
    });
  } catch (err) {
    setVmBadge("Boot Failed", "err");
    el.progressBar.textContent = `Boot error: ${err?.message ?? err}`;
    el.btnBoot.disabled = false;
    vm = null;
    resolveUserspace();
    return;
  }

  const bootMs = (performance.now() - t0).toFixed(0);
  setVmBadge("Running", "ok");
  setRunningUI(true);
  el.execOut.textContent = `Kernel started in ${bootMs} ms. Try running vm.exec()!`;

  const consoleTab = terminals.attachConsole(vm);

  const router = new ConsoleRouter({
    onKernelLine: (line, info) => {
      const prefix = info.important ? "[!] " : "";
      appendLog(el.kernelLogs, `${prefix}${line}\n`);
    },
    onUserOutput: (text) => {
      consoleTab.write(text);
    },
    onUserspace: (why) => {
      el.progressBar.textContent = `Linux booted (${why}). Interactive PTY ready.`;
      resolveUserspace();
    },
  });

  // Read vm.output stream so early boot lines + live chunks are routed cleanly.
  const consoleReader = vm.output.getReader();
  void (async () => {
    try {
      while (true) {
        const { value, done } = await consoleReader.read();
        if (done) break;
        router.write(value);
      }
      router.flush();
    } catch {
      // Stream closes on exit/stop.
    } finally {
      consoleReader.releaseLock();
    }
  })();

  statsTimer = setInterval(() => {
    if (!vm) return;
    const s = vm.stats();
    el.statsLine.textContent = `up ${(s.uptimeMs / 1000).toFixed(1)}s | cpus ${s.cpus} | jit blocks ${s.jit.blocks ?? 0}`;
  }, 1000);

  vm.exited.then((result) => {
    resolveUserspace();
    router.flush();
    clearInterval(statsTimer);
    statsTimer = null;
    setRunningUI(false);
    setVmBadge(`Exited (${result.kind}:${result.code})`, "muted");
    el.progressBar.textContent = `VM exited: kind=${result.kind}, code=${result.code}${result.reason ? `, reason=${result.reason}` : ""}`;
    consoleTab.write(`\r\n\x1b[90m[VM exited: ${result.kind} (${result.code})]\x1b[0m\r\n`);
    vm = null;
  });
}

el.btnBoot.addEventListener("click", () => {
  void boot();
});

el.btnPoweroff.addEventListener("click", () => {
  if (!vm) return;
  vm.write("poweroff\n");
});

el.btnStop.addEventListener("click", () => {
  if (!vm) return;
  vm.stop();
});

el.btnNewTab.addEventListener("click", () => {
  if (!vm) return;
  void terminals.openPtyTab(vm, () => userspaceReadyPromise);
});

el.btnCtrlC.addEventListener("click", () => {
  terminals.sendCtrlC();
});

for (const chip of el.quickChips) {
  chip.addEventListener("click", () => {
    if (!vm) return;
    terminals.sendToActive(`${chip.dataset.cmd}\r`);
  });
}

el.execForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!vm) return;
  const line = el.execIn.value.trim();
  if (!line) return;
  el.execOut.textContent = `Running: ${line}...`;
  try {
    const res = await vm.exec("/bin/sh", ["-c", line]);
    el.execOut.textContent =
      `exitCode: ${res.exitCode}\n` +
      (res.stdout ? `--- stdout ---\n${res.stdout}` : "") +
      (res.stderr ? `--- stderr ---\n${res.stderr}` : "");
  } catch (err) {
    el.execOut.textContent = `exec failed: ${err?.message ?? err}`;
  }
});

el.btnHostWrite.addEventListener("click", () => {
  if (!memFs) return;
  hostWriteCount += 1;
  const name = `/host-note-${hostWriteCount}.txt`;
  memFs.writeFile(name, `Created by browser host #${hostWriteCount} at ${new Date().toLocaleTimeString()}\n`);
  renderMemFs();
  appendLog(el.memfsEvents, `[host] wrote ${name}\n`);
});

void initSupportCheck();
