import {
  ConsoleRouter,
  MemoryFs,
  checkSupport,
  createKernel,
  type KernelInstance,
} from "unkernel";
import { TerminalManager } from "./terminal-manager.js";
import { CowView } from "./os-lens/cow-view";
import { LESSONS, type LessonScenario } from "./os-lens/lesson-guide";
import { KernelMemoryIntrospector } from "./os-lens/memory-introspector";
import { ProcTreeView } from "./os-lens/proc-tree-view";
import { Sv39View } from "./os-lens/sv39-view";
import type { GuestSnapshot } from "./os-lens/types";

const el = {
  supportBadge: document.getElementById("support-badge")!,
  vmBadge: document.getElementById("vm-badge")!,
  statusLine: document.getElementById("status-line")!,
  btnBoot: document.getElementById("btn-boot") as HTMLButtonElement,
  btnRefresh: document.getElementById("btn-refresh") as HTMLButtonElement,
  btnStop: document.getElementById("btn-stop") as HTMLButtonElement,
  lessonSelect: document.getElementById("lesson-select") as HTMLSelectElement,
  lessonSummary: document.getElementById("lesson-summary")!,
  lessonSteps: document.getElementById("lesson-steps")!,
  lessonExplain: document.getElementById("lesson-explain")!,
  tabBar: document.getElementById("tab-bar")!,
  btnNewTab: document.getElementById("btn-new-tab") as HTMLButtonElement,
  btnCtrlC: document.getElementById("btn-ctrl-c") as HTMLButtonElement,
  terminalStage: document.getElementById("terminal-stage")!,
  terminalEmpty: document.getElementById("terminal-empty")!,
  quickChips: [...document.querySelectorAll<HTMLButtonElement>(".chip")],
  vmstatLine: document.getElementById("vmstat-line")!,
  eventFeed: document.getElementById("event-feed")!,
  sv39Root: document.getElementById("sv39-root")!,
  cowRoot: document.getElementById("cow-root")!,
  procRoot: document.getElementById("proc-root")!,
};

const terminals = new TerminalManager({
  tabBar: el.tabBar,
  stage: el.terminalStage,
  emptyEl: el.terminalEmpty,
});

const introspector = new KernelMemoryIntrospector();
const sv39View = new Sv39View(el.sv39Root);
const cowView = new CowView(el.cowRoot);
const procView = new ProcTreeView(el.procRoot, (pid) => {
  if (lastSnapshot && pid !== lastSnapshot.parentPid) {
    sv39View.selectComparePid(pid);
    sv39View.render(lastSnapshot, lastReport);
  }
});

let vm: KernelInstance | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let userspaceReadyPromise = Promise.resolve();
let lastSnapshot: GuestSnapshot | null = null;
let lastReport: ReturnType<KernelMemoryIntrospector["inspect"]> | null = null;
let pollingInFlight = false;
let currentLesson: LessonScenario = LESSONS[1]!;

function setBadge(text: string, tone: "muted" | "ok" | "warn" | "err"): void {
  el.vmBadge.textContent = text;
  el.vmBadge.className = `badge badge-${tone}`;
}

function setRunningUI(running: boolean): void {
  el.btnBoot.disabled = running;
  el.btnRefresh.disabled = !running;
  el.btnStop.disabled = !running;
  el.btnNewTab.disabled = !running;
  el.btnCtrlC.disabled = !running;
  for (const chip of el.quickChips) chip.disabled = !running;
  renderLessonSteps();
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderLessonsDropdown(): void {
  el.lessonSelect.innerHTML = LESSONS.map(
    (l) => `<option value="${l.id}" ${l.id === currentLesson.id ? "selected" : ""}>${escapeHtml(l.title)}</option>`
  ).join("");
  el.lessonSummary.textContent = currentLesson.summary;
  renderLessonSteps();
}

function renderLessonSteps(): void {
  const running = vm !== null;
  el.lessonSteps.innerHTML = currentLesson.steps
    .map((step) => {
      const allowed = running && (step.canRun ? step.canRun(lastSnapshot) : true);
      return `<button class="step-btn" data-step="${step.id}" ${allowed ? "" : "disabled"}>${escapeHtml(step.label)}</button>`;
    })
    .join("");

  for (const btn of el.lessonSteps.querySelectorAll<HTMLButtonElement>(".step-btn")) {
    btn.addEventListener("click", () => {
      const step = currentLesson.steps.find((s) => s.id === btn.dataset.step);
      if (!step || !vm) return;
      el.lessonExplain.textContent = step.explain;
      const cmd = step.buildCmd(lastSnapshot);
      terminals.sendToActive(`${cmd}\r`);
      scheduleBurstPoll();
    });
  }
}

function renderEventFeed(snap: GuestSnapshot): void {
  el.vmstatLine.textContent = `pgfault=${snap.vmstat.pgfault} | anon_pages=${snap.vmstat.nrAnonPages} | free_pages=${snap.vmstat.nrFreePages}`;
  const items = [...snap.events].reverse().slice(0, 25);
  el.eventFeed.innerHTML = items
    .map(
      (ev) => `
      <div class="ev-item">
        <span class="ev-kind ev-kind-${escapeHtml(ev.kind)}">[${escapeHtml(ev.kind)}]</span>
        <span class="muted">#${ev.seq}</span>
        <span>${escapeHtml(ev.detail)}</span>
      </div>
    `
    )
    .join("");
}

async function pollOnce(): Promise<void> {
  if (!vm || pollingInFlight) return;
  pollingInFlight = true;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 900);
    const resp = await vm.fetch("http://127.0.0.1:8090/api/snapshot", {
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return;

    const snap = (await resp.json()) as GuestSnapshot;
    const report = introspector.inspect(vm.kernel, snap);
    lastSnapshot = snap;
    lastReport = report;

    sv39View.render(snap, report);
    cowView.render(snap, report);
    procView.render(snap);
    renderEventFeed(snap);
    renderLessonSteps();
  } catch {
    // oslab HTTP server may still be starting up right after boot
  } finally {
    pollingInFlight = false;
  }
}

function scheduleBurstPoll(): void {
  for (const delayMs of [60, 200, 480]) {
    setTimeout(() => {
      void pollOnce();
    }, delayMs);
  }
}

async function initSupportCheck(): Promise<void> {
  const report = await checkSupport();
  if (report.ok) {
    el.supportBadge.textContent = "JSPI Ready";
    el.supportBadge.className = "badge badge-ok";
  } else {
    el.supportBadge.textContent = "Unsupported Browser";
    el.supportBadge.className = "badge badge-err";
    el.btnBoot.disabled = true;
    el.statusLine.textContent = `Missing browser support: ${report.problems.join("; ")}. Requires Chrome/Edge 137+, Firefox 153+, or Safari 27+.`;
  }
}

async function boot(): Promise<void> {
  if (vm) return;

  introspector.reset();
  lastSnapshot = null;
  lastReport = null;
  sv39View.render(null, null);
  cowView.render(null, null);
  procView.render(null);
  el.eventFeed.innerHTML = "";
  setBadge("Booting", "warn");
  el.btnBoot.disabled = true;
  el.statusLine.textContent = "Loading /oslab arm64 binary & booting Linux 7.3.4 (inline mode)...";

  let oslabBytes: Uint8Array;
  try {
    const res = await fetch("/oslab");
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching /oslab`);
    oslabBytes = new Uint8Array(await res.arrayBuffer());
  } catch (err: any) {
    setBadge("Asset Missing", "err");
    el.statusLine.textContent = `Failed to load /oslab (${err?.message ?? err}). Run "npm run build:oslab" first.`;
    el.btnBoot.disabled = false;
    return;
  }

  const memFs = new MemoryFs();
  memFs.writeFile("/oslab", oslabBytes, { mode: 0o755 });

  let resolveUserspace!: () => void;
  userspaceReadyPromise = new Promise<void>((resolve) => {
    resolveUserspace = resolve;
  });

  const t0 = performance.now();
  try {
    vm = await createKernel({
      worker: false,
      memoryMiB: 256,
      memoryFallbackMiB: [256, 192, 128],
      shm: true,
      mounts: {
        "/opt/oslab": memFs,
      },
      onProgress: (p) => {
        el.statusLine.textContent = `Kernel boot stage: ${p.stage}`;
      },
    });
  } catch (err: any) {
    setBadge("Boot Failed", "err");
    el.statusLine.textContent = `Boot failed: ${err?.message ?? err}`;
    el.btnBoot.disabled = false;
    vm = null;
    resolveUserspace();
    return;
  }

  const bootMs = (performance.now() - t0).toFixed(0);
  setBadge("Running", "ok");
  setRunningUI(true);
  el.statusLine.textContent = `Linux booted in ${bootMs} ms. Starting /opt/oslab/oslab interactive REPL...`;

  const consoleTab = terminals.attachConsole(vm);
  const router = new ConsoleRouter({
    onUserOutput: (text) => consoleTab.write(text),
    onUserspace: () => {
      el.statusLine.textContent = `OS Lab ready (${vm?.memoryMiB ?? 256} MiB RAM). 在左侧终端输入 mmap() / fork() 或点击上方实验步骤！`;
      resolveUserspace();
    },
  });

  const reader = vm.output.getReader();
  void (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        router.write(value);
      }
      router.flush();
    } catch {
      // closes at exit
    } finally {
      reader.releaseLock();
    }
  })();

  // Auto-open interactive oslab REPL tab once userspace & mounts are ready
  const oslabTab = await terminals.openPtyTab(vm, () => userspaceReadyPromise, {
    file: "/opt/oslab/oslab",
    args: [],
    title: "oslab (交互实验台)",
    closable: false,
  });

  if (oslabTab) {
    oslabTab.term.onData((d: string) => {
      if (d.includes("\r") || d.includes("\n")) {
        scheduleBurstPoll();
      }
    });
  }

  pollTimer = setInterval(() => {
    void pollOnce();
  }, 750);
  scheduleBurstPoll();

  void vm.exited.then((result) => {
    resolveUserspace();
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    setRunningUI(false);
    setBadge(`Exited (${result.kind})`, "muted");
    el.statusLine.textContent = `VM exited: ${result.kind} (${result.code})`;
    vm = null;
  });
}

el.lessonSelect.addEventListener("change", () => {
  const found = LESSONS.find((l) => l.id === el.lessonSelect.value);
  if (found) {
    currentLesson = found;
    el.lessonSummary.textContent = currentLesson.summary;
    el.lessonExplain.textContent = currentLesson.steps[0]?.explain ?? "";
    renderLessonSteps();
  }
});

el.btnBoot.addEventListener("click", () => {
  void boot();
});

el.btnRefresh.addEventListener("click", () => {
  void pollOnce();
});

el.btnStop.addEventListener("click", () => {
  if (!vm) return;
  void vm.stop();
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
    scheduleBurstPoll();
  });
}

renderLessonsDropdown();
el.lessonExplain.textContent = currentLesson.steps[0]?.explain ?? "";
sv39View.render(null, null);
cowView.render(null, null);
procView.render(null);
void initSupportCheck();
