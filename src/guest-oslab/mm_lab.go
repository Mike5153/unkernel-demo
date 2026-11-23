package main

import (
	"fmt"
	"runtime"
	"sync"
	"syscall"
	"unsafe"
)

const PageSize = 4096

type MappedRegion struct {
	ID       int      `json:"id"`
	Name     string   `json:"name"`
	Addr     uint64   `json:"addr"`
	AddrHex  string   `json:"addrHex"`
	Pages    int      `json:"pages"`
	Size     int      `json:"size"`
	Prot     string   `json:"prot"`
	ProtBits int      `json:"protBits"`
	Shared   bool     `json:"shared"`
	RawSlice []byte   `json:"-"`
}

type ChildProcess struct {
	PID     int    `json:"pid"`
	PPID    int    `json:"ppid"`
	Alive   bool   `json:"alive"`
	Zombie  bool   `json:"zombie"`
	Status  string `json:"status"`
	ExitCode int   `json:"exitCode"`
	cmdFd   int
	ackFd   int
}

type LabEvent struct {
	Seq     int    `json:"seq"`
	Kind    string `json:"kind"`
	PID     int    `json:"pid"`
	Detail  string `json:"detail"`
	VA      string `json:"va,omitempty"`
	Pages   int    `json:"pages,omitempty"`
}

type LabManager struct {
	mu         sync.Mutex
	parentPID  int
	canaryAddr uint64
	canaryRaw  []byte
	canaryPFN  uint64
	regions    []*MappedRegion
	nextRegID  int
	children   map[int]*ChildProcess
	childOrder []int
	events     []LabEvent
	seq        int
}

func NewLabManager() (*LabManager, error) {
	m := &LabManager{
		parentPID: syscall.Getpid(),
		children:  make(map[int]*ChildProcess),
	}
	// Allocate a 1-page canary and touch it immediately so Host JS can auto-calibrate
	// physical->linear offset and locate our Sv39 PGD root page table in Wasm memory.
	raw, err := syscall.Mmap(-1, 0, PageSize, syscall.PROT_READ|syscall.PROT_WRITE, syscall.MAP_PRIVATE|syscall.MAP_ANONYMOUS)
	if err != nil {
		return nil, fmt.Errorf("canary mmap: %v", err)
	}
	m.canaryRaw = raw
	m.canaryAddr = uint64(uintptr(unsafe.Pointer(&raw[0])))
	sig := fmt.Sprintf("OSLAB_CANARY_V1:PID=%d", m.parentPID)
	copy(raw, sig)

	pm := readPagemapEntries(m.parentPID, m.canaryAddr, 1)
	if len(pm) == 1 && pm[0].Present {
		m.canaryPFN = pm[0].PFN
	}
	m.recordEvent("boot", m.parentPID, fmt.Sprintf("oslab ready (canary va=0x%x pfn=0x%x)", m.canaryAddr, m.canaryPFN), fmt.Sprintf("0x%x", m.canaryAddr), 1)
	return m, nil
}

func (m *LabManager) recordEvent(kind string, pid int, detail, va string, pages int) {
	m.seq++
	ev := LabEvent{
		Seq:    m.seq,
		Kind:   kind,
		PID:    pid,
		Detail: detail,
		VA:     va,
		Pages:  pages,
	}
	m.events = append(m.events, ev)
	if len(m.events) > 80 {
		m.events = m.events[len(m.events)-80:]
	}
}

func parseProt(prot string) (int, string) {
	switch prot {
	case "r", "ro", "PROT_READ":
		return syscall.PROT_READ, "r--"
	case "rx":
		return syscall.PROT_READ | syscall.PROT_EXEC, "r-x"
	case "none", "---":
		return syscall.PROT_NONE, "---"
	case "rw", "PROT_READ|PROT_WRITE", "":
		fallthrough
	default:
		return syscall.PROT_READ | syscall.PROT_WRITE, "rw-"
	}
}

func (m *LabManager) Mmap(pages int, protStr string, shared bool) (*MappedRegion, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if pages < 1 {
		pages = 1
	}
	if pages > 16 {
		pages = 16
	}
	protBits, protNorm := parseProt(protStr)
	flags := syscall.MAP_ANONYMOUS
	if shared {
		flags |= syscall.MAP_SHARED
	} else {
		flags |= syscall.MAP_PRIVATE
	}

	raw, err := syscall.Mmap(-1, 0, pages*PageSize, protBits, flags)
	if err != nil {
		return nil, err
	}
	// Do NOT touch `raw` here! Keep it untouched so Sv39 PTE stays unmapped (demand paging).
	addr := uint64(uintptr(unsafe.Pointer(&raw[0])))
	id := m.nextRegID
	m.nextRegID++
	reg := &MappedRegion{
		ID:       id,
		Name:     fmt.Sprintf("r%d", id),
		Addr:     addr,
		AddrHex:  fmt.Sprintf("0x%x", addr),
		Pages:    pages,
		Size:     pages * PageSize,
		Prot:     protNorm,
		ProtBits: protBits,
		Shared:   shared,
		RawSlice: raw,
	}
	m.regions = append(m.regions, reg)
	m.recordEvent("mmap", m.parentPID, fmt.Sprintf("mmap(%d pages, %s) -> %s (lazy, V=0)", pages, protNorm, reg.AddrHex), reg.AddrHex, pages)
	return reg, nil
}

func (m *LabManager) findRegionLocked(id int) *MappedRegion {
	for _, r := range m.regions {
		if r.ID == id {
			return r
		}
	}
	return nil
}

func (m *LabManager) ReadRegion(id int, pageIdx int) (uint64, string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	r := m.findRegionLocked(id)
	if r == nil {
		return 0, "", fmt.Errorf("region r%d not found", id)
	}
	if pageIdx < 0 || pageIdx >= r.Pages {
		return 0, "", fmt.Errorf("page index %d out of range [0..%d)", pageIdx, r.Pages)
	}
	off := pageIdx * PageSize
	va := r.Addr + uint64(off)
	b := make([]byte, 48)
	copy(b, r.RawSlice[off:off+48])
	end := 0
	for end < len(b) && b[end] != 0 {
		end++
	}
	preview := string(b[:end])
	if preview == "" {
		preview = "<zeros>"
	}
	m.recordEvent("page_read", m.parentPID, fmt.Sprintf("PID %d read r%d[%d] @ 0x%x -> %q", m.parentPID, id, pageIdx, va, preview), fmt.Sprintf("0x%x", va), 1)
	return va, preview, nil
}

func (m *LabManager) WriteRegion(id int, pageIdx int, text string) (uint64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	r := m.findRegionLocked(id)
	if r == nil {
		return 0, fmt.Errorf("region r%d not found", id)
	}
	if pageIdx < 0 || pageIdx >= r.Pages {
		return 0, fmt.Errorf("page index %d out of range [0..%d)", pageIdx, r.Pages)
	}
	off := pageIdx * PageSize
	va := r.Addr + uint64(off)
	payload := []byte(text)
	if len(payload) > 255 {
		payload = payload[:255]
	}
	for i := 0; i < 256; i++ {
		if i < len(payload) {
			r.RawSlice[off+i] = payload[i]
		} else {
			r.RawSlice[off+i] = 0
		}
	}
	m.recordEvent("page_write", m.parentPID, fmt.Sprintf("PID %d wrote r%d[%d] @ 0x%x (%q)", m.parentPID, id, pageIdx, va, text), fmt.Sprintf("0x%x", va), 1)
	return va, nil
}

func (m *LabManager) Munmap(id int) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	idx := -1
	var reg *MappedRegion
	for i, r := range m.regions {
		if r.ID == id {
			idx = i
			reg = r
			break
		}
	}
	if idx < 0 || reg == nil {
		return fmt.Errorf("region r%d not found", id)
	}
	if err := syscall.Munmap(reg.RawSlice); err != nil {
		return err
	}
	m.regions = append(m.regions[:idx], m.regions[idx+1:]...)
	m.recordEvent("munmap", m.parentPID, fmt.Sprintf("munmap(r%d @ %s, %d pages)", id, reg.AddrHex, reg.Pages), reg.AddrHex, reg.Pages)
	return nil
}

func (m *LabManager) Mprotect(id int, protStr string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	r := m.findRegionLocked(id)
	if r == nil {
		return fmt.Errorf("region r%d not found", id)
	}
	protBits, protNorm := parseProt(protStr)
	if err := syscall.Mprotect(r.RawSlice, protBits); err != nil {
		return err
	}
	r.Prot = protNorm
	r.ProtBits = protBits
	m.recordEvent("mprotect", m.parentPID, fmt.Sprintf("mprotect(r%d @ %s, %s)", id, r.AddrHex, protNorm), r.AddrHex, r.Pages)
	return nil
}

// Fork spawns a genuine child process via SYS_clone(SIGCHLD, 0).
// The child runs strictly via syscall.RawSyscall with zero Go allocations.
func (m *LabManager) Fork() (*ChildProcess, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	var cmdPipe [2]int
	var ackPipe [2]int
	if err := syscall.Pipe2(cmdPipe[:], 0); err != nil {
		return nil, fmt.Errorf("pipe2 cmd: %v", err)
	}
	if err := syscall.Pipe2(ackPipe[:], 0); err != nil {
		syscall.Close(cmdPipe[0])
		syscall.Close(cmdPipe[1])
		return nil, fmt.Errorf("pipe2 ack: %v", err)
	}

	// Snapshot active region base pointers on stack-friendly slices before fork.
	regCount := len(m.regions)
	regAddrs := make([]uint64, regCount)
	regPages := make([]int, regCount)
	for i, r := range m.regions {
		regAddrs[i] = r.Addr
		regPages[i] = r.Pages
	}
	canaryAddr := m.canaryAddr

	runtime.LockOSThread()
	pid, _, errno := syscall.RawSyscall6(syscall.SYS_CLONE, uintptr(syscall.SIGCHLD), 0, 0, 0, 0, 0)
	if pid == 0 && errno == 0 {
		// === CHILD PROCESS ===
		// Only use syscall.RawSyscall and stack arrays! Never allocate or touch Go runtime.
		childRawLoop(cmdPipe[0], cmdPipe[1], ackPipe[0], ackPipe[1], canaryAddr, regAddrs, regPages)
		syscall.RawSyscall(syscall.SYS_EXIT, 0, 0, 0)
	}
	runtime.UnlockOSThread()

	if errno != 0 {
		syscall.Close(cmdPipe[0])
		syscall.Close(cmdPipe[1])
		syscall.Close(ackPipe[0])
		syscall.Close(ackPipe[1])
		return nil, fmt.Errorf("fork SYS_clone failed: %v", errno)
	}

	// Parent closes child's pipe ends
	syscall.Close(cmdPipe[0])
	syscall.Close(ackPipe[1])

	cp := &ChildProcess{
		PID:    int(pid),
		PPID:   m.parentPID,
		Alive:  true,
		Status: "ready (CoW armed)",
		cmdFd:  cmdPipe[1],
		ackFd:  ackPipe[0],
	}
	m.children[cp.PID] = cp
	m.childOrder = append(m.childOrder, cp.PID)
	m.recordEvent("fork", cp.PID, fmt.Sprintf("fork() -> child PID %d (PTE W=0 CoW shared)", cp.PID), "", 0)
	return cp, nil
}

// childRawLoop runs inside the forked child using ONLY RawSyscall (async-signal-safe).
// Packet format from parent (160 bytes):
//   [0]: op ('R', 'W', 'X')
//   [1]: region index (0..254)
//   [2]: page index (0..254)
//   [3]: payload length (0..120)
//   [4..123]: payload bytes
// Ack packet back to parent (128 bytes):
//   [0]: status ('O' = ok, 'E' = error)
//   [1]: data length
//   [2..127]: data preview
func childRawLoop(cmdR, cmdW, ackR, ackW int, canaryAddr uint64, regAddrs []uint64, regPages []int) {
	syscall.RawSyscall(syscall.SYS_CLOSE, uintptr(cmdW), 0, 0)
	syscall.RawSyscall(syscall.SYS_CLOSE, uintptr(ackR), 0, 0)

	var cmd [160]byte
	var ack [128]byte

	for {
		n, _, err := syscall.RawSyscall(syscall.SYS_READ, uintptr(cmdR), uintptr(unsafe.Pointer(&cmd[0])), uintptr(len(cmd)))
		if err != 0 || n == 0 {
			break
		}
		op := cmd[0]
		if op == 'X' {
			ack[0] = 'O'
			ack[1] = 2
			ack[2] = 'B'
			ack[3] = 'Y'
			syscall.RawSyscall(syscall.SYS_WRITE, uintptr(ackW), uintptr(unsafe.Pointer(&ack[0])), 128)
			break
		}
		rIdx := int(cmd[1])
		pIdx := int(cmd[2])
		if rIdx < 0 || rIdx >= len(regAddrs) || pIdx < 0 || pIdx >= regPages[rIdx] {
			ack[0] = 'E'
			ack[1] = 0
			syscall.RawSyscall(syscall.SYS_WRITE, uintptr(ackW), uintptr(unsafe.Pointer(&ack[0])), 128)
			continue
		}

		va := uintptr(regAddrs[rIdx]) + uintptr(pIdx*PageSize)
		// Ensure canary stays referenced (no-op read)
		_ = *(*byte)(unsafe.Pointer(uintptr(canaryAddr)))

		if op == 'R' {
			var outLen byte = 48
			for i := 0; i < 48; i++ {
				b := *(*byte)(unsafe.Pointer(va + uintptr(i)))
				ack[2+i] = b
				if b == 0 && outLen == 48 {
					outLen = byte(i)
				}
			}
			ack[0] = 'O'
			ack[1] = outLen
		} else if op == 'W' {
			plen := int(cmd[3])
			if plen > 120 {
				plen = 120
			}
			for i := 0; i < 120; i++ {
				var v byte
				if i < plen {
					v = cmd[4+i]
				}
				*(*byte)(unsafe.Pointer(va + uintptr(i))) = v
			}
			ack[0] = 'O'
			ack[1] = byte(plen)
			for i := 0; i < plen; i++ {
				ack[2+i] = cmd[4+i]
			}
		} else {
			ack[0] = 'E'
			ack[1] = 0
		}
		syscall.RawSyscall(syscall.SYS_WRITE, uintptr(ackW), uintptr(unsafe.Pointer(&ack[0])), 128)
	}

	syscall.RawSyscall(syscall.SYS_CLOSE, uintptr(cmdR), 0, 0)
	syscall.RawSyscall(syscall.SYS_CLOSE, uintptr(ackW), 0, 0)
	syscall.RawSyscall(syscall.SYS_EXIT, 0, 0, 0)
}

func (m *LabManager) findRegionIndexLocked(id int) (int, *MappedRegion) {
	for i, r := range m.regions {
		if r.ID == id {
			return i, r
		}
	}
	return -1, nil
}

func (m *LabManager) ChildRead(pid int, regID int, pageIdx int) (uint64, string, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	cp := m.children[pid]
	if cp == nil || !cp.Alive {
		return 0, "", fmt.Errorf("child PID %d is not alive", pid)
	}
	rIdx, r := m.findRegionIndexLocked(regID)
	if r == nil {
		return 0, "", fmt.Errorf("region r%d not found", regID)
	}
	if pageIdx < 0 || pageIdx >= r.Pages {
		return 0, "", fmt.Errorf("page index %d out of range", pageIdx)
	}
	var cmd [160]byte
	cmd[0] = 'R'
	cmd[1] = byte(rIdx)
	cmd[2] = byte(pageIdx)
	if _, err := syscall.Write(cp.cmdFd, cmd[:]); err != nil {
		return 0, "", err
	}
	var ack [128]byte
	if _, err := syscall.Read(cp.ackFd, ack[:]); err != nil {
		return 0, "", err
	}
	if ack[0] != 'O' {
		return 0, "", fmt.Errorf("child read error (region may not exist in child)")
	}
	preview := string(ack[2 : 2+int(ack[1])])
	if preview == "" {
		preview = "<zeros>"
	}
	va := r.Addr + uint64(pageIdx*PageSize)
	m.recordEvent("child_read", pid, fmt.Sprintf("child PID %d read r%d[%d] @ 0x%x -> %q", pid, regID, pageIdx, va, preview), fmt.Sprintf("0x%x", va), 1)
	return va, preview, nil
}

func (m *LabManager) ChildWrite(pid int, regID int, pageIdx int, text string) (uint64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	cp := m.children[pid]
	if cp == nil || !cp.Alive {
		return 0, fmt.Errorf("child PID %d is not alive", pid)
	}
	rIdx, r := m.findRegionIndexLocked(regID)
	if r == nil {
		return 0, fmt.Errorf("region r%d not found", regID)
	}
	if pageIdx < 0 || pageIdx >= r.Pages {
		return 0, fmt.Errorf("page index %d out of range", pageIdx)
	}
	payload := []byte(text)
	if len(payload) > 120 {
		payload = payload[:120]
	}
	var cmd [160]byte
	cmd[0] = 'W'
	cmd[1] = byte(rIdx)
	cmd[2] = byte(pageIdx)
	cmd[3] = byte(len(payload))
	copy(cmd[4:], payload)

	if _, err := syscall.Write(cp.cmdFd, cmd[:]); err != nil {
		return 0, err
	}
	var ack [128]byte
	if _, err := syscall.Read(cp.ackFd, ack[:]); err != nil {
		return 0, err
	}
	if ack[0] != 'O' {
		return 0, fmt.Errorf("child write error (region may not exist in child)")
	}
	va := r.Addr + uint64(pageIdx*PageSize)
	cp.Status = fmt.Sprintf("wrote r%d[%d] (CoW split)", regID, pageIdx)
	m.recordEvent("cow_write", pid, fmt.Sprintf("child PID %d wrote r%d[%d] @ 0x%x (%q) -> CoW split", pid, regID, pageIdx, va, text), fmt.Sprintf("0x%x", va), 1)
	return va, nil
}

func (m *LabManager) ChildExit(pid int) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	cp := m.children[pid]
	if cp == nil || !cp.Alive {
		return fmt.Errorf("child PID %d is not alive", pid)
	}
	var cmd [160]byte
	cmd[0] = 'X'
	_, _ = syscall.Write(cp.cmdFd, cmd[:])
	var ack [128]byte
	_, _ = syscall.Read(cp.ackFd, ack[:])
	syscall.Close(cp.cmdFd)
	syscall.Close(cp.ackFd)
	cp.Alive = false
	cp.Zombie = true
	cp.Status = "exited (zombie until wait)"
	m.recordEvent("child_exit", pid, fmt.Sprintf("child PID %d exited (zombie until wait())", pid), "", 0)
	return nil
}

func (m *LabManager) WaitChild(targetPid int) (int, int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	var ws syscall.WaitStatus
	wpid, err := syscall.Wait4(targetPid, &ws, syscall.WNOHANG, nil)
	if err != nil {
		return 0, 0, err
	}
	if wpid == 0 {
		// Blocking wait if target is exiting now
		wpid, err = syscall.Wait4(targetPid, &ws, 0, nil)
		if err != nil {
			return 0, 0, err
		}
	}
	if cp, ok := m.children[wpid]; ok {
		cp.Alive = false
		cp.Zombie = false
		cp.ExitCode = ws.ExitStatus()
		cp.Status = fmt.Sprintf("reaped (exit=%d)", cp.ExitCode)
	}
	m.recordEvent("wait", wpid, fmt.Sprintf("wait4() reaped PID %d (exit=%d)", wpid, ws.ExitStatus()), "", 0)
	return wpid, ws.ExitStatus(), nil
}
