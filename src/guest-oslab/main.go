package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
)

type RegionPagemap struct {
	RegionID int            `json:"regionId"`
	Name     string         `json:"name"`
	AddrHex  string         `json:"addrHex"`
	Pages    int            `json:"pages"`
	Prot     string         `json:"prot"`
	Shared   bool           `json:"shared"`
	ByPID    map[string][]PagemapEntry `json:"byPid"`
}

type SnapshotResponse struct {
	ParentPID    int                `json:"parentPid"`
	CanaryVA     string             `json:"canaryVa"`
	CanaryPFN    uint64             `json:"canaryPfn"`
	CanaryByPID  map[string]uint64  `json:"canaryByPid"`
	Regions      []*MappedRegion    `json:"regions"`
	RegionPages  []RegionPagemap    `json:"regionPages"`
	Children     []*ChildProcess    `json:"children"`
	ProcTree     []ProcNode         `json:"procTree"`
	MapsByPID    map[string][]VmaInfo `json:"mapsByPid"`
	VmStat       VmStatInfo         `json:"vmstat"`
	Events       []LabEvent         `json:"events"`
}

func buildSnapshot(m *LabManager) SnapshotResponse {
	m.mu.Lock()
	parentPID := m.parentPID
	canaryAddr := m.canaryAddr
	canaryPFN := m.canaryPFN

	regionsCopy := make([]*MappedRegion, len(m.regions))
	copy(regionsCopy, m.regions)

	childrenCopy := make([]*ChildProcess, 0, len(m.childOrder))
	labPids := map[int]bool{parentPID: true}
	activePids := []int{parentPID}
	for _, pid := range m.childOrder {
		if cp, ok := m.children[pid]; ok {
			cpCopy := *cp
			childrenCopy = append(childrenCopy, &cpCopy)
			labPids[pid] = true
			if cp.Alive {
				activePids = append(activePids, pid)
			}
		}
	}

	eventsCopy := make([]LabEvent, len(m.events))
	copy(eventsCopy, m.events)
	m.mu.Unlock()

	canaryByPID := make(map[string]uint64)
	mapsByPID := make(map[string][]VmaInfo)
	for _, pid := range activePids {
		pidKey := strconv.Itoa(pid)
		pm := readPagemapEntries(pid, canaryAddr, 1)
		if len(pm) == 1 && pm[0].Present {
			canaryByPID[pidKey] = pm[0].PFN
		}
		mapsByPID[pidKey] = readProcMaps(pid, 40)
	}

	regionPages := make([]RegionPagemap, 0, len(regionsCopy))
	for _, r := range regionsCopy {
		rp := RegionPagemap{
			RegionID: r.ID,
			Name:     r.Name,
			AddrHex:  r.AddrHex,
			Pages:    r.Pages,
			Prot:     r.Prot,
			Shared:   r.Shared,
			ByPID:    make(map[string][]PagemapEntry),
		}
		for _, pid := range activePids {
			rp.ByPID[strconv.Itoa(pid)] = readPagemapEntries(pid, r.Addr, r.Pages)
		}
		regionPages = append(regionPages, rp)
	}

	return SnapshotResponse{
		ParentPID:   parentPID,
		CanaryVA:    fmt.Sprintf("0x%x", canaryAddr),
		CanaryPFN:   canaryPFN,
		CanaryByPID: canaryByPID,
		Regions:     regionsCopy,
		RegionPages: regionPages,
		Children:    childrenCopy,
		ProcTree:    readProcTree(labPids),
		MapsByPID:   mapsByPID,
		VmStat:      readVmStat(),
		Events:      eventsCopy,
	}
}

func startHTTPServer(m *LabManager, addr string) {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/snapshot", func(w http.ResponseWriter, r *http.Request) {
		snap := buildSnapshot(m)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(snap)
	})
	mux.HandleFunc("/api/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"ok":true,"pid":%d}`, m.parentPID)
	})
	go func() {
		_ = http.ListenAndServe(addr, mux)
	}()
}

func printHelp() {
	fmt.Println("\x1b[36m=== oslab — 交互式 Linux 内核机制实验台 (arm64 / Sv39 MMU) ===\x1b[0m")
	fmt.Println("  \x1b[33mmmap([pages], [prot])\x1b[0m       匿名映射 N 页 (例: mmap() / mmap(2, rw) / mmap 1 shared)")
	fmt.Println("  \x1b[33mread <rID> [page]\x1b[0m           父进程读取区域页 (首次读触发缺页中断)")
	fmt.Println("  \x1b[33mwrite <rID> [page] <text>\x1b[0m   父进程写入字符串 (触发缺页或写时复制分裂)")
	fmt.Println("  \x1b[33mfork()\x1b[0m                      调用 SYS_clone 创建子进程 (父子 PTE W=0 共享 PFN)")
	fmt.Println("  \x1b[33mchild <pid> read <rID> [p]\x1b[0m  让指定子进程读取映射页")
	fmt.Println("  \x1b[33mchild <pid> write <rID> [p] <text>\x1b[0m 让子进程写入映射页 (触发 CoW 物理页分裂)")
	fmt.Println("  \x1b[33mchild <pid> exit\x1b[0m            子进程退出 (进入 Zombie 状态)")
	fmt.Println("  \x1b[33mwait [pid]\x1b[0m                  父进程 wait4() 回收僵尸子进程")
	fmt.Println("  \x1b[33mmprotect <rID> <r|rw|none>\x1b[0m  修改 VMA 权限")
	fmt.Println("  \x1b[33mmunmap <rID>\x1b[0m                解除虚拟内存映射")
	fmt.Println("  \x1b[33msysinfo / ps / maps\x1b[0m         查看当前区域、子进程、/proc/self/maps")
	fmt.Println("  \x1b[33m!<shell cmd>\x1b[0m                在 /bin/sh 执行任意 Linux 命令 (例: !ps -ef)")
	fmt.Println("  \x1b[33mhelp / clear / exit\x1b[0m         帮助 / 清屏 / 退出")
}

func parseRegionID(s string) (int, bool) {
	s = strings.TrimSpace(s)
	s = strings.TrimPrefix(s, "r")
	id, err := strconv.Atoi(s)
	return id, err == nil
}

func normalizeLine(raw string) []string {
	line := strings.TrimSpace(raw)
	if line == "" {
		return nil
	}
	// Support C-like call syntax: fork(), mmap(2, rw), munmap(r0), write(r0, 0, "hi")
	if idx := strings.IndexByte(line, '('); idx > 0 && strings.HasSuffix(line, ")") {
		fn := strings.TrimSpace(line[:idx])
		inner := strings.TrimSpace(line[idx+1 : len(line)-1])
		args := []string{fn}
		if inner != "" {
			for _, part := range strings.Split(inner, ",") {
				p := strings.TrimSpace(part)
				p = strings.Trim(p, `"'`)
				if p != "" {
					args = append(args, p)
				}
			}
		}
		return args
	}
	// Standard whitespace split keeping quoted tail
	var tokens []string
	var cur strings.Builder
	inQuote := false
	var qChar byte
	for i := 0; i < len(line); i++ {
		c := line[i]
		if inQuote {
			if c == qChar {
				inQuote = false
			} else {
				cur.WriteByte(c)
			}
			continue
		}
		if c == '"' || c == '\'' {
			inQuote = true
			qChar = c
			continue
		}
		if c == ' ' || c == '\t' {
			if cur.Len() > 0 {
				tokens = append(tokens, cur.String())
				cur.Reset()
			}
			continue
		}
		cur.WriteByte(c)
	}
	if cur.Len() > 0 {
		tokens = append(tokens, cur.String())
	}
	return tokens
}

func handleCommand(m *LabManager, line string) bool {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" {
		return true
	}
	if strings.HasPrefix(trimmed, "!") {
		cmdStr := strings.TrimSpace(trimmed[1:])
		if cmdStr != "" {
			c := exec.Command("/bin/sh", "-c", cmdStr)
			c.Stdout = os.Stdout
			c.Stderr = os.Stderr
			c.Stdin = os.Stdin
			if err := c.Run(); err != nil {
				fmt.Printf("\x1b[31m[sh] %v\x1b[0m\n", err)
			}
		}
		return true
	}

	args := normalizeLine(trimmed)
	if len(args) == 0 {
		return true
	}
	op := strings.ToLower(args[0])
	switch op {
	case "help", "?":
		printHelp()
	case "clear":
		fmt.Print("\x1b[2J\x1b[H")
	case "exit", "quit":
		return false
	case "mmap":
		pages := 1
		prot := "rw"
		shared := false
		for _, a := range args[1:] {
			if a == "shared" || a == "MAP_SHARED" {
				shared = true
			} else if n, err := strconv.Atoi(a); err == nil {
				pages = n
			} else {
				prot = a
			}
		}
		reg, err := m.Mmap(pages, prot, shared)
		if err != nil {
			fmt.Printf("\x1b[31mmmap failed: %v\x1b[0m\n", err)
		} else {
			fmt.Printf("\x1b[32m[mmap]\x1b[0m id=%s addr=\x1b[33m%s\x1b[0m size=%d (%d pages) prot=%s shared=%v (lazy: PTE V=0)\n",
				reg.Name, reg.AddrHex, reg.Size, reg.Pages, reg.Prot, reg.Shared)
		}
	case "read":
		if len(args) < 2 {
			fmt.Println("usage: read <rID> [pageIdx]")
			break
		}
		id, ok := parseRegionID(args[1])
		if !ok {
			fmt.Println("invalid region id (expected e.g. r0 or 0)")
			break
		}
		pageIdx := 0
		if len(args) >= 3 {
			pageIdx, _ = strconv.Atoi(args[2])
		}
		va, preview, err := m.ReadRegion(id, pageIdx)
		if err != nil {
			fmt.Printf("\x1b[31mread failed: %v\x1b[0m\n", err)
		} else {
			fmt.Printf("\x1b[32m[read]\x1b[0m r%d[%d] va=0x%x -> %q\n", id, pageIdx, va, preview)
		}
	case "write":
		if len(args) < 3 {
			fmt.Println("usage: write <rID> [pageIdx] <text>")
			break
		}
		id, ok := parseRegionID(args[1])
		if !ok {
			fmt.Println("invalid region id")
			break
		}
		pageIdx := 0
		textIdx := 2
		if len(args) >= 4 {
			if p, err := strconv.Atoi(args[2]); err == nil {
				pageIdx = p
				textIdx = 3
			}
		}
		text := strings.Join(args[textIdx:], " ")
		va, err := m.WriteRegion(id, pageIdx, text)
		if err != nil {
			fmt.Printf("\x1b[31mwrite failed: %v\x1b[0m\n", err)
		} else {
			fmt.Printf("\x1b[32m[write]\x1b[0m PID %d wrote %q to r%d[%d] (va=0x%x)\n", m.parentPID, text, id, pageIdx, va)
		}
	case "fork":
		cp, err := m.Fork()
		if err != nil {
			fmt.Printf("\x1b[31mfork failed: %v\x1b[0m\n", err)
		} else {
			fmt.Printf("\x1b[35m[fork]\x1b[0m parent PID=%d -> child PID=\x1b[33m%d\x1b[0m (CoW armed: shared PFNs, PTE W=0)\n", m.parentPID, cp.PID)
		}
	case "child":
		if len(args) < 3 {
			fmt.Println("usage: child <pid> <read|write|exit> ...")
			break
		}
		pid, err := strconv.Atoi(args[1])
		if err != nil {
			fmt.Println("invalid child pid")
			break
		}
		sub := strings.ToLower(args[2])
		switch sub {
		case "exit":
			if err := m.ChildExit(pid); err != nil {
				fmt.Printf("\x1b[31mchild exit failed: %v\x1b[0m\n", err)
			} else {
				fmt.Printf("\x1b[33m[child %d]\x1b[0m exited (now Zombie Z until wait)\n", pid)
			}
		case "read":
			if len(args) < 4 {
				fmt.Println("usage: child <pid> read <rID> [pageIdx]")
				break
			}
			regID, ok := parseRegionID(args[3])
			if !ok {
				fmt.Println("invalid region id")
				break
			}
			pageIdx := 0
			if len(args) >= 5 {
				pageIdx, _ = strconv.Atoi(args[4])
			}
			va, preview, err := m.ChildRead(pid, regID, pageIdx)
			if err != nil {
				fmt.Printf("\x1b[31mchild read failed: %v\x1b[0m\n", err)
			} else {
				fmt.Printf("\x1b[32m[child %d read]\x1b[0m r%d[%d] va=0x%x -> %q\n", pid, regID, pageIdx, va, preview)
			}
		case "write":
			if len(args) < 5 {
				fmt.Println("usage: child <pid> write <rID> [pageIdx] <text>")
				break
			}
			regID, ok := parseRegionID(args[3])
			if !ok {
				fmt.Println("invalid region id")
				break
			}
			pageIdx := 0
			textIdx := 4
			if len(args) >= 6 {
				if p, err := strconv.Atoi(args[4]); err == nil {
					pageIdx = p
					textIdx = 5
				}
			}
			text := strings.Join(args[textIdx:], " ")
			va, err := m.ChildWrite(pid, regID, pageIdx, text)
			if err != nil {
				fmt.Printf("\x1b[31mchild write failed: %v\x1b[0m\n", err)
			} else {
				fmt.Printf("\x1b[35m[child %d write]\x1b[0m wrote %q to r%d[%d] (va=0x%x) -> CoW split!\n", pid, text, regID, pageIdx, va)
			}
		default:
			fmt.Printf("unknown child action: %s\n", sub)
		}
	case "wait":
		target := -1
		if len(args) >= 2 {
			target, _ = strconv.Atoi(args[1])
		}
		wpid, code, err := m.WaitChild(target)
		if err != nil {
			fmt.Printf("\x1b[31mwait failed: %v\x1b[0m\n", err)
		} else {
			fmt.Printf("\x1b[32m[wait]\x1b[0m reaped child PID=%d exit=%d\n", wpid, code)
		}
	case "mprotect":
		if len(args) < 3 {
			fmt.Println("usage: mprotect <rID> <r|rw|rx|none>")
			break
		}
		id, ok := parseRegionID(args[1])
		if !ok {
			fmt.Println("invalid region id")
			break
		}
		if err := m.Mprotect(id, args[2]); err != nil {
			fmt.Printf("\x1b[31mmprotect failed: %v\x1b[0m\n", err)
		} else {
			fmt.Printf("\x1b[32m[mprotect]\x1b[0m r%d -> %s\n", id, args[2])
		}
	case "munmap":
		if len(args) < 2 {
			fmt.Println("usage: munmap <rID>")
			break
		}
		id, ok := parseRegionID(args[1])
		if !ok {
			fmt.Println("invalid region id")
			break
		}
		if err := m.Munmap(id); err != nil {
			fmt.Printf("\x1b[31mmunmap failed: %v\x1b[0m\n", err)
		} else {
			fmt.Printf("\x1b[32m[munmap]\x1b[0m unmapped r%d\n", id)
		}
	case "sysinfo", "status", "regions":
		snap := buildSnapshot(m)
		fmt.Printf("PID=%d canary=%s (pfn=0x%x) pgfault=%d\n", snap.ParentPID, snap.CanaryVA, snap.CanaryPFN, snap.VmStat.PgFault)
		for _, r := range snap.Regions {
			fmt.Printf("  %s: va=%s pages=%d prot=%s shared=%v\n", r.Name, r.AddrHex, r.Pages, r.Prot, r.Shared)
		}
		for _, c := range snap.Children {
			fmt.Printf("  child pid=%d alive=%v zombie=%v (%s)\n", c.PID, c.Alive, c.Zombie, c.Status)
		}
	case "maps":
		for _, v := range readProcMaps(m.parentPID, 30) {
			fmt.Printf("  %s-%s %s %s\n", v.Start, v.End, v.Perms, v.Path)
		}
	case "ps":
		c := exec.Command("/bin/sh", "-c", "ps")
		c.Stdout = os.Stdout
		c.Stderr = os.Stderr
		_ = c.Run()
	default:
		// If user typed a standard shell command (like ls, cat, uname, sleep), run it via /bin/sh
		c := exec.Command("/bin/sh", "-c", trimmed)
		c.Stdout = os.Stdout
		c.Stderr = os.Stderr
		c.Stdin = os.Stdin
		if err := c.Run(); err != nil {
			fmt.Printf("\x1b[31munknown command %q (type 'help' for oslab commands)\x1b[0m\n", args[0])
		}
	}
	return true
}

func main() {
	httpAddr := flag.String("http", "127.0.0.1:8090", "HTTP snapshot listen address")
	flag.Parse()

	mgr, err := NewLabManager()
	if err != nil {
		fmt.Fprintf(os.Stderr, "oslab init failed: %v\n", err)
		os.Exit(1)
	}
	startHTTPServer(mgr, *httpAddr)

	fmt.Printf("\x1b[36m[oslab]\x1b[0m PID=%d | HTTP=%s | Canary=%s (PFN=0x%x)\n",
		syscall.Getpid(), *httpAddr, fmt.Sprintf("0x%x", mgr.canaryAddr), mgr.canaryPFN)
	printHelp()

	scanner := bufio.NewScanner(os.Stdin)
	for {
		fmt.Print("\x1b[32moslab>\x1b[0m ")
		if !scanner.Scan() {
			break
		}
		if !handleCommand(mgr, scanner.Text()) {
			break
		}
	}
}
