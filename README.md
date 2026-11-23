# unkernel Demo — 浏览器内多节点 Raft 混沌工程实验台 & 多标签交互式终端

基于 [pithings/unkernel](https://github.com/pithings/unkernel) JavaScript/TypeScript SDK 构建，包含两个可无缝切换的页面：

1. **Raft Chaos Lab (`/`)** — 按 [docs/raft-chaos-cluster-design.md](docs/raft-chaos-cluster-design.md) 实现的浏览器内 3~5 节点真实 Linux Raft 集群与可视化混沌工程实验台：
   - **控制面与数据面分离**：节点间 Raft RPC（`:2380`）走独立 Web Worker 内联 `createKernel()` + 自定义 `NetDevice` L2 原始以太网帧桥接，经由主线程 TypeScript 虚拟 L2 交换机（含内置 DHCP、MAC 学习、TCP 重传/DupACK/RTT 旁路嗅探与链路混沌规则引擎）；宿主机控制面通过独立 `vsock` 采集 `/_chaos/status`、`/proc/net/snmp`、`/proc/net/tcp`、执行 `kill -9` 与打开 `@xterm/xterm` 带外终端。
   - **静态编译 `aarch64` Go Raft 服务**：无外部依赖，通过 `MemoryFs` 挂载到 `/opt/raft/raft-node` 启动。
   - **可视化混沌面板**：支持定向/双向链路延迟、抖动、随机丢包、物理断线、一键脑裂、拔网线、`SIGKILL` vs `worker.terminate()` 断电对比、KV 写入压测及毫秒级统一事件时间线。
2. **unkernel Terminal (`/terminal.html`)** — 保留的原单节点多标签交互式 Linux 终端（`hvc0` 控制台 + `vm.spawn()` PTY 会话 + `vm.exec()` + `/mnt/host` `MemoryFs`）。
3. **OS 内核透视镜 (`/os-lens.html`)** — 交互式 OS 教材分屏应用：左侧 Linux 终端运行静态 `arm64` Go `oslab` 实验台（支持 `mmap()`、`read`/`write` 触发缺页中断、`fork()`、`child write` 触发写时复制、`wait4()` 回收僵尸进程），右侧宿主机 JS 直读 `vm.kernel.memory.buffer` 与 `/proc` 状态，实时渲染 Sv39 三级页表映射、CoW 物理页分裂过程（含 4 KiB 物理 RAM 实时内容）及 `/proc` 进程树。

## 环境要求

`unkernel` 依赖 **WebAssembly JSPI (`WebAssembly.Suspending` / `WebAssembly.promising`)**：

- **浏览器（Web 原型）**：Chrome / Edge 137+、Firefox 153+、Safari 27+
- **Go 编译器**（用于构建 guest `raft-node` 静态 `linux/arm64` 二进制）：Go >= 1.15
- **Node.js**（仅 `node-demo` 脚本需要）：Node.js >= 24

## 快速开始

```bash
npm install

# 1. 编译静态 aarch64 Guest 二进制到 public/raft-node 和 public/oslab
npm run build:raft   # Windows PowerShell；Linux/macOS 可运行 sh src/guest-raft/build.sh
npm run build:oslab  # Windows PowerShell；Linux/macOS 可运行 sh src/guest-oslab/build.sh

# 2. 启动 Vite 开发服务器
npm run dev
```

打开 Vite 输出的地址：
- `/` — **Raft Chaos Lab**（点击 **Boot Cluster** 启动 3~5 节点集群）
- `/terminal.html` — **unkernel Terminal**（点击 **Boot Linux** 启动单节点终端）
- `/os-lens.html` — **OS 内核透视镜**（点击 **Boot OS Lab** 启动交互式 OS 教材分屏实验台）

构建生产包：

```bash
npm run build
npm run preview
```

## 目录结构

- [index.html](index.html) / [src/main.ts](src/main.ts) / [src/chaos.css](src/chaos.css) — Raft Chaos Lab 入口
- [terminal.html](terminal.html) / [src/main.js](src/main.js) / [src/style.css](src/style.css) — 原单节点多标签终端
- [src/terminal-manager.js](src/terminal-manager.js) — `@xterm/xterm` 多标签终端管理器
- [src/cluster/](src/cluster/) — `VirtualL2Switch`、`DhcpResponder`、`NetDevice`、`node-worker.ts`、`ClusterManager`
- [src/ui/](src/ui/) — 拓扑视图、混沌注入面板、内核 TCP 遥测图表与时间线、节点终端抽屉
- [src/guest-raft/](src/guest-raft/) — 静态 `linux/arm64` Go Raft 服务源码与构建脚本
- [src/guest-oslab/](src/guest-oslab/) — 静态 `linux/arm64` Go OS 内核透视镜实验台源码与构建脚本
- [os-lens.html](os-lens.html) / [src/os-lens.ts](src/os-lens.ts) / [src/os-lens/](src/os-lens/) — OS 内核透视镜（Sv39 页表直读、CoW 物理页分裂、`/proc` 进程树）
- [src/node-demo.mjs](src/node-demo.mjs) — Node.js 端最小 SDK 示例
- [docs/raft-chaos-cluster-design.md](docs/raft-chaos-cluster-design.md) — Raft 集群混沌工程方案设计文档
- [docs/project-architecture.md](docs/project-architecture.md) — 项目核心结构与架构梳理文档
- [docs/os-lens-workflow.md](docs/os-lens-workflow.md) — OS Lab（OS 内核透视镜）完整运行流程梳理文档
