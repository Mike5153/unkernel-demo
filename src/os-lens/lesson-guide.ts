import type { GuestSnapshot } from "./types";

export interface LessonStep {
  id: string;
  label: string;
  explain: string;
  buildCmd: (snap: GuestSnapshot | null) => string;
  canRun?: (snap: GuestSnapshot | null) => boolean;
}

export interface LessonScenario {
  id: string;
  title: string;
  summary: string;
  steps: LessonStep[];
}

function latestAliveChildPid(snap: GuestSnapshot | null): number | null {
  if (!snap) return null;
  for (let i = snap.children.length - 1; i >= 0; i--) {
    const c = snap.children[i]!;
    if (c.alive) return c.pid;
  }
  return null;
}

function latestZombieChildPid(snap: GuestSnapshot | null): number | null {
  if (!snap) return null;
  for (let i = snap.children.length - 1; i >= 0; i--) {
    const c = snap.children[i]!;
    if (c.zombie) return c.pid;
  }
  return null;
}

function latestRegionName(snap: GuestSnapshot | null): string {
  if (!snap || snap.regions.length === 0) return "r0";
  return snap.regions[snap.regions.length - 1]!.name;
}

export const LESSONS: LessonScenario[] = [
  {
    id: "demand-paging",
    title: "实验 1：mmap() 懒分配与缺页中断",
    summary: "观察内核如何只建立 VMA 而不立即分配物理页，直到首次读写触发 Minor Page Fault。",
    steps: [
      {
        id: "dp-mmap",
        label: "1. mmap(1, rw)",
        explain: "向内核申请 1 页匿名映射。此时仅在 mm_struct 创建 VMA，Sv39 L0 PTE 仍为 0 (V=0)。",
        buildCmd: () => "mmap(1, rw)",
      },
      {
        id: "dp-read",
        label: "2. read rN 0 (触发缺页)",
        explain: "读取刚映射的虚拟地址，CPU 触发缺页中断 (handle_mm_fault -> do_anonymous_page)，内核分配物理 PFN 并填充零页。",
        buildCmd: (snap) => `read ${latestRegionName(snap)} 0`,
        canRun: (snap) => (snap?.regions.length ?? 0) > 0,
      },
      {
        id: "dp-write",
        label: "3. write rN 0 \"hello-sv39\"",
        explain: "向物理页写入数据，可在右侧 CoW 物理帧视图直接看到宿主机从 Wasm 内存读出的 ASCII 字节。",
        buildCmd: (snap) => `write ${latestRegionName(snap)} 0 "hello-sv39"`,
        canRun: (snap) => (snap?.regions.length ?? 0) > 0,
      },
    ],
  },
  {
    id: "cow-fork",
    title: "实验 2：fork() 与写时复制 (CoW) 物理页分裂",
    summary: "演示 fork() 后父子共享同一物理 PFN（PTE W=0 只读保护），子进程写入时触发物理页分裂。",
    steps: [
      {
        id: "cow-prep",
        label: "1. 准备父进程脏页",
        explain: "先 mmap(1, rw) 并写入初始数据 \"parent-v1\"，确保父进程已拥有物理页帧。",
        buildCmd: () => `mmap(1, rw)`,
      },
      {
        id: "cow-seed",
        label: "2. 写入 \"parent-v1\"",
        explain: "触发父进程缺页分配并写入数据，待会儿 fork() 后子进程将共享此物理页。",
        buildCmd: (snap) => `write ${latestRegionName(snap)} 0 "parent-v1"`,
        canRun: (snap) => (snap?.regions.length ?? 0) > 0,
      },
      {
        id: "cow-fork",
        label: "3. fork() 复制页表",
        explain: "调用 SYS_clone：copy_page_range() 复制父进程页表并把父子 PTE 的 W 位清 0，双方共享同一 PFN。",
        buildCmd: () => "fork()",
      },
      {
        id: "cow-child-read",
        label: "4. 子进程只读 (不分裂)",
        explain: "子进程读取同一 VA，硬件/内核允许读访问，PFN 仍然共享，不发生物理页拷贝。",
        buildCmd: (snap) => `child ${latestAliveChildPid(snap) ?? "<pid>"} read ${latestRegionName(snap)} 0`,
        canRun: (snap) => latestAliveChildPid(snap) !== null && (snap?.regions.length ?? 0) > 0,
      },
      {
        id: "cow-child-write",
        label: "5. 子进程写入 (触发 CoW 分裂!)",
        explain: "子进程尝试写入只读 CoW 页，触发写保护缺页 (wp_page_copy)：内核分配新 PFN、拷贝 4KiB，双方分裂！",
        buildCmd: (snap) => `child ${latestAliveChildPid(snap) ?? "<pid>"} write ${latestRegionName(snap)} 0 "child-cow"`,
        canRun: (snap) => latestAliveChildPid(snap) !== null && (snap?.regions.length ?? 0) > 0,
      },
    ],
  },
  {
    id: "zombie-reap",
    title: "实验 3：进程退出、Zombie 态与 wait4() 回收",
    summary: "观察子进程退出后如何滞留 /proc 进程树为 Z (Zombie) 状态，以及父进程 wait() 回收过程。",
    steps: [
      {
        id: "zr-fork",
        label: "1. fork() 新建子进程",
        explain: "若当前无存活子进程，先创建一个子进程。",
        buildCmd: () => "fork()",
      },
      {
        id: "zr-exit",
        label: "2. child exit (变僵尸 Z)",
        explain: "子进程调用 SYS_exit，释放 mm_struct 但保留 task_struct 与退出码，/proc 显示为 Z (Zombie)。",
        buildCmd: (snap) => `child ${latestAliveChildPid(snap) ?? "<pid>"} exit`,
        canRun: (snap) => latestAliveChildPid(snap) !== null,
      },
      {
        id: "zr-wait",
        label: "3. wait4() 回收僵尸",
        explain: "父进程调用 wait4() 读取退出码并释放子进程 PCB，节点从活跃进程树消失。",
        buildCmd: (snap) => `wait ${latestZombieChildPid(snap) ?? ""}`.trim(),
        canRun: (snap) => latestZombieChildPid(snap) !== null,
      },
    ],
  },
];
