package main

import (
	"encoding/binary"
	"fmt"
	"io/ioutil"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
)

type ProcNode struct {
	PID      int      `json:"pid"`
	PPID     int      `json:"ppid"`
	Comm     string   `json:"comm"`
	State    string   `json:"state"`
	Cmdline  string   `json:"cmdline"`
	VmSizeKB int64    `json:"vmSizeKb"`
	VmRssKB  int64    `json:"vmRssKb"`
	Threads  int      `json:"threads"`
	MinFlt   uint64   `json:"minFlt"`
	MajFlt   uint64   `json:"majFlt"`
	Children []int    `json:"children"`
	IsLab    bool     `json:"isLab"`
}

type VmaInfo struct {
	Start  string `json:"start"`
	End    string `json:"end"`
	Perms  string `json:"perms"`
	Offset string `json:"offset"`
	Path   string `json:"path"`
}

type PagemapEntry struct {
	VA        string `json:"va"`
	Present   bool   `json:"present"`
	Swapped   bool   `json:"swapped"`
	FileAnon  bool   `json:"fileAnon"`
	SoftDirty bool   `json:"softDirty"`
	PFN       uint64 `json:"pfn"`
	RawHex    string `json:"rawHex"`
}

type VmStatInfo struct {
	PgFault    uint64 `json:"pgfault"`
	PgMajFault uint64 `json:"pgmajfault"`
	NrAnonPages uint64 `json:"nrAnonPages"`
	NrFreePages uint64 `json:"nrFreePages"`
}

func readVmStat() VmStatInfo {
	var info VmStatInfo
	data, err := ioutil.ReadFile("/proc/vmstat")
	if err != nil {
		return info
	}
	lines := strings.Split(string(data), "\n")
	for _, line := range lines {
		fields := strings.Fields(line)
		if len(fields) != 2 {
			continue
		}
		v, err := strconv.ParseUint(fields[1], 10, 64)
		if err != nil {
			continue
		}
		switch fields[0] {
		case "pgfault":
			info.PgFault = v
		case "pgmajfault":
			info.PgMajFault = v
		case "nr_anon_pages":
			info.NrAnonPages = v
		case "nr_free_pages":
			info.NrFreePages = v
		}
	}
	return info
}

func readProcTree(labPids map[int]bool) []ProcNode {
	entries, err := ioutil.ReadDir("/proc")
	if err != nil {
		return nil
	}
	var pids []int
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid <= 0 {
			continue
		}
		pids = append(pids, pid)
	}
	sort.Ints(pids)

	nodes := make([]ProcNode, 0, len(pids))
	childMap := make(map[int][]int)

	for _, pid := range pids {
		node, ok := readSingleProc(pid, labPids[pid])
		if !ok {
			continue
		}
		nodes = append(nodes, node)
		childMap[node.PPID] = append(childMap[node.PPID], node.PID)
	}

	for i := range nodes {
		if kids, ok := childMap[nodes[i].PID]; ok {
			sort.Ints(kids)
			nodes[i].Children = kids
		} else {
			nodes[i].Children = []int{}
		}
	}
	return nodes
}

func readSingleProc(pid int, isLab bool) (ProcNode, bool) {
	base := fmt.Sprintf("/proc/%d", pid)
	statBytes, err := ioutil.ReadFile(filepath.Join(base, "stat"))
	if err != nil {
		return ProcNode{}, false
	}
	statStr := string(statBytes)
	lp := strings.IndexByte(statStr, '(')
	rp := strings.LastIndexByte(statStr, ')')
	if lp < 0 || rp <= lp {
		return ProcNode{}, false
	}
	comm := statStr[lp+1 : rp]
	rest := strings.Fields(statStr[rp+1:])
	if len(rest) < 12 {
		return ProcNode{}, false
	}
	state := rest[0]
	ppid, _ := strconv.Atoi(rest[1])
	minFlt, _ := strconv.ParseUint(rest[7], 10, 64)
	majFlt, _ := strconv.ParseUint(rest[9], 10, 64)

	var vmSizeKB, vmRssKB int64
	threads := 1
	if statusBytes, err := ioutil.ReadFile(filepath.Join(base, "status")); err == nil {
		for _, line := range strings.Split(string(statusBytes), "\n") {
			if strings.HasPrefix(line, "VmSize:") {
				fields := strings.Fields(line)
				if len(fields) >= 2 {
					vmSizeKB, _ = strconv.ParseInt(fields[1], 10, 64)
				}
			} else if strings.HasPrefix(line, "VmRSS:") {
				fields := strings.Fields(line)
				if len(fields) >= 2 {
					vmRssKB, _ = strconv.ParseInt(fields[1], 10, 64)
				}
			} else if strings.HasPrefix(line, "Threads:") {
				fields := strings.Fields(line)
				if len(fields) >= 2 {
					threads, _ = strconv.Atoi(fields[1])
				}
			}
		}
	}

	cmdline := comm
	if cmdBytes, err := ioutil.ReadFile(filepath.Join(base, "cmdline")); err == nil && len(cmdBytes) > 0 {
		clean := strings.TrimSpace(strings.ReplaceAll(string(cmdBytes), "\x00", " "))
		if clean != "" {
			cmdline = clean
		}
	}

	return ProcNode{
		PID:      pid,
		PPID:     ppid,
		Comm:     comm,
		State:    state,
		Cmdline:  cmdline,
		VmSizeKB: vmSizeKB,
		VmRssKB:  vmRssKB,
		Threads:  threads,
		MinFlt:   minFlt,
		MajFlt:   majFlt,
		IsLab:    isLab,
	}, true
}

func readProcMaps(pid int, limit int) []VmaInfo {
	data, err := ioutil.ReadFile(fmt.Sprintf("/proc/%d/maps", pid))
	if err != nil {
		return nil
	}
	lines := strings.Split(strings.TrimSpace(string(data)), "\n")
	out := make([]VmaInfo, 0, len(lines))
	for _, line := range lines {
		fields := strings.Fields(line)
		if len(fields) < 5 {
			continue
		}
		rng := strings.SplitN(fields[0], "-", 2)
		if len(rng) != 2 {
			continue
		}
		path := "[anon]"
		if len(fields) >= 6 {
			path = strings.Join(fields[5:], " ")
		}
		out = append(out, VmaInfo{
			Start:  "0x" + rng[0],
			End:    "0x" + rng[1],
			Perms:  fields[1],
			Offset: "0x" + fields[2],
			Path:   path,
		})
		if limit > 0 && len(out) >= limit {
			break
		}
	}
	return out
}

func readPagemapEntries(pid int, baseAddr uint64, pageCount int) []PagemapEntry {
	out := make([]PagemapEntry, 0, pageCount)
	path := fmt.Sprintf("/proc/%d/pagemap", pid)
	f, err := os.Open(path)
	if err != nil {
		for i := 0; i < pageCount; i++ {
			va := baseAddr + uint64(i)*4096
			out = append(out, PagemapEntry{
				VA:     fmt.Sprintf("0x%x", va),
				RawHex: "0x0",
			})
		}
		return out
	}
	defer f.Close()

	buf := make([]byte, 8)
	for i := 0; i < pageCount; i++ {
		va := baseAddr + uint64(i)*4096
		vpn := va / 4096
		off := int64(vpn * 8)
		n, err := syscall.Pread(int(f.Fd()), buf, off)
		var val uint64
		if err == nil && n == 8 {
			val = binary.LittleEndian.Uint64(buf)
		}
		present := (val & (1 << 63)) != 0
		swapped := (val & (1 << 62)) != 0
		fileAnon := (val & (1 << 61)) != 0
		softDirty := (val & (1 << 55)) != 0
		var pfn uint64
		if present {
			pfn = val & ((uint64(1) << 55) - 1)
		}
		out = append(out, PagemapEntry{
			VA:        fmt.Sprintf("0x%x", va),
			Present:   present,
			Swapped:   swapped,
			FileAnon:  fileAnon,
			SoftDirty: softDirty,
			PFN:       pfn,
			RawHex:    fmt.Sprintf("0x%016x", val),
		})
	}
	return out
}
