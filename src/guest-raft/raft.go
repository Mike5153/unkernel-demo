package main

import (
	"encoding/json"
	"fmt"
	"io/ioutil"
	"log"
	"math/rand"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"
)

type Role string

const (
	RoleFollower  Role = "Follower"
	RoleCandidate Role = "Candidate"
	RoleLeader    Role = "Leader"
)

type LogEntry struct {
	Index int    `json:"index"`
	Term  int    `json:"term"`
	Key   string `json:"key"`
	Value string `json:"value"`
}

type RequestVoteReq struct {
	Term         int    `json:"term"`
	CandidateID  string `json:"candidateId"`
	LastLogIndex int    `json:"lastLogIndex"`
	LastLogTerm  int    `json:"lastLogTerm"`
}

type RequestVoteResp struct {
	Term        int  `json:"term"`
	VoteGranted bool `json:"voteGranted"`
}

type AppendEntriesReq struct {
	Term         int        `json:"term"`
	LeaderID     string     `json:"leaderId"`
	PrevLogIndex int        `json:"prevLogIndex"`
	PrevLogTerm  int        `json:"prevLogTerm"`
	Entries      []LogEntry `json:"entries,omitempty"`
	LeaderCommit int        `json:"leaderCommit"`
}

type AppendEntriesResp struct {
	Term          int  `json:"term"`
	Success       bool `json:"success"`
	ConflictIndex int  `json:"conflictIndex,omitempty"`
	ConflictTerm  int  `json:"conflictTerm,omitempty"`
}

type PeerStatus struct {
	Addr          string `json:"addr"`
	NextIndex     int    `json:"nextIndex"`
	MatchIndex    int    `json:"matchIndex"`
	Connected     bool   `json:"connected"`
	LastContactMs int64  `json:"lastContactMs"`
	LastRttMs     int64  `json:"lastRttMs"`
	LastError     string `json:"lastError,omitempty"`
}

type StatusSnapshot struct {
	NodeID       string                `json:"nodeId"`
	PID          int                   `json:"pid"`
	Role         Role                  `json:"role"`
	Term         int                   `json:"term"`
	LeaderID     string                `json:"leaderId"`
	VotedFor     string                `json:"votedFor"`
	CommitIndex  int                   `json:"commitIndex"`
	AppliedIndex int                   `json:"appliedIndex"`
	LastLogIndex int                   `json:"lastLogIndex"`
	LastLogTerm  int                   `json:"lastLogTerm"`
	KVCount      int                   `json:"kvCount"`
	UptimeMs     int64                 `json:"uptimeMs"`
	Peers        map[string]PeerStatus `json:"peers"`
}

type RaftConfig struct {
	ID          string
	ListenAddr  string
	HTTPAddr    string
	Peers       map[string]string
	Heartbeat   time.Duration
	ElectionMin time.Duration
	ElectionMax time.Duration
	DataDir     string
}

type persistedState struct {
	CurrentTerm int        `json:"currentTerm"`
	VotedFor    string     `json:"votedFor"`
	Log         []LogEntry `json:"log"`
}

type peerTrack struct {
	id          string
	addr        string
	nextIndex   int
	matchIndex  int
	connected   bool
	lastContact time.Time
	lastRttMs   int64
	lastError   string
	notifyCh    chan struct{}
}

type RaftNode struct {
	mu  sync.Mutex
	cfg RaftConfig

	startedAt time.Time
	stopped   int32

	role        Role
	currentTerm int
	votedFor    string
	leaderID    string
	log         []LogEntry // 1-indexed; log[0] is dummy {Index:0, Term:0}

	commitIndex  int
	appliedIndex int
	kv           map[string]string
	waiters      map[int]chan error

	peers      map[string]*peerTrack
	transport  *Transport
	httpServer *HTTPServer

	electionDeadline time.Time
	stopCh           chan struct{}
	applyCh          chan struct{}
}

func NewRaftNode(cfg RaftConfig) (*RaftNode, error) {
	n := &RaftNode{
		cfg:       cfg,
		startedAt: time.Now(),
		role:      RoleFollower,
		log:       []LogEntry{{Index: 0, Term: 0}},
		kv:        make(map[string]string),
		waiters:   make(map[int]chan error),
		peers:     make(map[string]*peerTrack),
		stopCh:    make(chan struct{}),
		applyCh:   make(chan struct{}, 1),
	}

	if err := n.loadState(); err != nil {
		return nil, err
	}

	for id, addr := range cfg.Peers {
		if id == cfg.ID {
			continue
		}
		n.peers[id] = &peerTrack{
			id:        id,
			addr:      addr,
			nextIndex: len(n.log),
			notifyCh:  make(chan struct{}, 1),
		}
	}

	n.resetElectionDeadlineLocked()
	n.transport = NewTransport(cfg.ListenAddr, n)
	n.httpServer = NewHTTPServer(cfg.HTTPAddr, n)
	return n, nil
}

func (n *RaftNode) Start() error {
	if err := n.transport.Start(); err != nil {
		return err
	}
	if err := n.httpServer.Start(); err != nil {
		n.transport.Stop()
		return err
	}

	go n.electionLoop()
	go n.applyLoop()
	for _, p := range n.peers {
		go n.peerReplicationLoop(p)
	}
	return nil
}

func (n *RaftNode) Stop() {
	if !atomic.CompareAndSwapInt32(&n.stopped, 0, 1) {
		return
	}
	close(n.stopCh)
	n.httpServer.Stop()
	n.transport.Stop()
}

func (n *RaftNode) isStopped() bool {
	return atomic.LoadInt32(&n.stopped) != 0
}

func (n *RaftNode) statePath() string {
	if n.cfg.DataDir == "" {
		return ""
	}
	return filepath.Join(n.cfg.DataDir, fmt.Sprintf("raft-%s.json", n.cfg.ID))
}

func (n *RaftNode) loadState() error {
	path := n.statePath()
	if path == "" {
		return nil
	}
	data, err := ioutil.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	var st persistedState
	if err := json.Unmarshal(data, &st); err != nil {
		return nil
	}
	n.currentTerm = st.CurrentTerm
	n.votedFor = st.VotedFor
	if len(st.Log) > 0 {
		n.log = st.Log
	}
	return nil
}

func (n *RaftNode) saveStateLocked() {
	path := n.statePath()
	if path == "" {
		return
	}
	if err := os.MkdirAll(n.cfg.DataDir, 0755); err != nil {
		return
	}
	st := persistedState{
		CurrentTerm: n.currentTerm,
		VotedFor:    n.votedFor,
		Log:         n.log,
	}
	b, err := json.Marshal(st)
	if err != nil {
		return
	}
	tmp := path + ".tmp"
	if err := ioutil.WriteFile(tmp, b, 0644); err == nil {
		_ = os.Rename(tmp, path)
	}
}

func (n *RaftNode) lastLogIndexTermLocked() (int, int) {
	last := n.log[len(n.log)-1]
	return last.Index, last.Term
}

func (n *RaftNode) resetElectionDeadlineLocked() {
	span := n.cfg.ElectionMax - n.cfg.ElectionMin
	jitter := time.Duration(0)
	if span > 0 {
		jitter = time.Duration(rand.Int63n(int64(span)))
	}
	n.electionDeadline = time.Now().Add(n.cfg.ElectionMin + jitter)
}

func (n *RaftNode) becomeFollowerLocked(term int, leaderID string) {
	prevRole := n.role
	if term > n.currentTerm {
		n.currentTerm = term
		n.votedFor = ""
	}
	n.role = RoleFollower
	if leaderID != "" {
		n.leaderID = leaderID
	} else if term > n.currentTerm {
		n.leaderID = ""
	}
	if prevRole == RoleLeader {
		n.failAllWaitersLocked(fmt.Errorf("lost leadership in term %d", n.currentTerm))
	}
	n.saveStateLocked()
}

func (n *RaftNode) failAllWaitersLocked(err error) {
	for idx, ch := range n.waiters {
		select {
		case ch <- err:
		default:
		}
		delete(n.waiters, idx)
	}
}

func (n *RaftNode) notifyApplyLocked() {
	select {
	case n.applyCh <- struct{}{}:
	default:
	}
}

func (n *RaftNode) notifyPeersLocked() {
	for _, p := range n.peers {
		select {
		case p.notifyCh <- struct{}{}:
		default:
		}
	}
}

func (n *RaftNode) electionLoop() {
	ticker := time.NewTicker(40 * time.Millisecond)
	defer ticker.Stop()

	for {
		select {
		case <-n.stopCh:
			return
		case <-ticker.C:
			n.mu.Lock()
			if n.role != RoleLeader && time.Now().After(n.electionDeadline) {
				n.startElectionLocked()
			}
			n.mu.Unlock()
		}
	}
}

func (n *RaftNode) startElectionLocked() {
	n.role = RoleCandidate
	n.currentTerm++
	n.votedFor = n.cfg.ID
	n.leaderID = ""
	n.resetElectionDeadlineLocked()
	n.saveStateLocked()

	term := n.currentTerm
	lastIdx, lastTerm := n.lastLogIndexTermLocked()
	totalNodes := len(n.peers) + 1
	needed := totalNodes/2 + 1

	log.Printf("[raft:%s] starting election term=%d lastIdx=%d lastTerm=%d", n.cfg.ID, term, lastIdx, lastTerm)

	var votes int32 = 1
	if int(votes) >= needed {
		n.becomeLeaderLocked()
		return
	}

	req := RequestVoteReq{
		Term:         term,
		CandidateID:  n.cfg.ID,
		LastLogIndex: lastIdx,
		LastLogTerm:  lastTerm,
	}

	for _, p := range n.peers {
		go func(peer *peerTrack) {
			resp, err := n.transport.SendRequestVote(peer.id, peer.addr, req, 700*time.Millisecond)
			if err != nil {
				return
			}
			n.mu.Lock()
			defer n.mu.Unlock()

			if resp.Term > n.currentTerm {
				n.becomeFollowerLocked(resp.Term, "")
				n.resetElectionDeadlineLocked()
				return
			}
			if n.role != RoleCandidate || n.currentTerm != term {
				return
			}
			if resp.VoteGranted {
				v := atomic.AddInt32(&votes, 1)
				if int(v) >= needed && n.role == RoleCandidate {
					n.becomeLeaderLocked()
				}
			}
		}(p)
	}
}

func (n *RaftNode) becomeLeaderLocked() {
	n.role = RoleLeader
	n.leaderID = n.cfg.ID
	lastIdx, _ := n.lastLogIndexTermLocked()
	for _, p := range n.peers {
		p.nextIndex = lastIdx + 1
		p.matchIndex = 0
	}
	log.Printf("[raft:%s] became LEADER term=%d lastIdx=%d", n.cfg.ID, n.currentTerm, lastIdx)
	n.notifyPeersLocked()
}

func (n *RaftNode) peerReplicationLoop(p *peerTrack) {
	ticker := time.NewTicker(n.cfg.Heartbeat)
	defer ticker.Stop()

	for {
		select {
		case <-n.stopCh:
			return
		case <-p.notifyCh:
			n.sendAppendToPeer(p)
		case <-ticker.C:
			n.sendAppendToPeer(p)
		}
	}
}

func (n *RaftNode) sendAppendToPeer(p *peerTrack) {
	n.mu.Lock()
	if n.role != RoleLeader {
		n.mu.Unlock()
		return
	}
	term := n.currentTerm
	prevIdx := p.nextIndex - 1
	if prevIdx < 0 {
		prevIdx = 0
	}
	if prevIdx >= len(n.log) {
		prevIdx = len(n.log) - 1
	}
	prevTerm := n.log[prevIdx].Term

	var entries []LogEntry
	if p.nextIndex < len(n.log) {
		slice := n.log[p.nextIndex:]
		if len(slice) > 64 {
			slice = slice[:64]
		}
		entries = make([]LogEntry, len(slice))
		copy(entries, slice)
	}

	req := AppendEntriesReq{
		Term:         term,
		LeaderID:     n.cfg.ID,
		PrevLogIndex: prevIdx,
		PrevLogTerm:  prevTerm,
		Entries:      entries,
		LeaderCommit: n.commitIndex,
	}
	n.mu.Unlock()

	t0 := time.Now()
	resp, err := n.transport.SendAppendEntries(p.id, p.addr, req, 1200*time.Millisecond)
	rtt := time.Since(t0).Milliseconds()

	n.mu.Lock()
	defer n.mu.Unlock()

	if err != nil {
		p.connected = false
		p.lastError = err.Error()
		return
	}

	p.connected = true
	p.lastContact = time.Now()
	p.lastRttMs = rtt
	p.lastError = ""

	if resp.Term > n.currentTerm {
		n.becomeFollowerLocked(resp.Term, "")
		n.resetElectionDeadlineLocked()
		return
	}
	if n.role != RoleLeader || n.currentTerm != term {
		return
	}

	if resp.Success {
		matched := prevIdx + len(entries)
		if matched > p.matchIndex {
			p.matchIndex = matched
		}
		if matched+1 > p.nextIndex {
			p.nextIndex = matched + 1
		}
		n.advanceCommitIndexLocked()
		if p.nextIndex < len(n.log) {
			select {
			case p.notifyCh <- struct{}{}:
			default:
			}
		}
	} else {
		if resp.ConflictTerm > 0 {
			foundIdx := -1
			for i := len(n.log) - 1; i >= 1; i-- {
				if n.log[i].Term == resp.ConflictTerm {
					foundIdx = i
					break
				}
			}
			if foundIdx > 0 {
				p.nextIndex = foundIdx + 1
			} else if resp.ConflictIndex > 0 {
				p.nextIndex = resp.ConflictIndex
			} else if p.nextIndex > 1 {
				p.nextIndex--
			}
		} else if resp.ConflictIndex > 0 {
			p.nextIndex = resp.ConflictIndex
		} else if p.nextIndex > 1 {
			p.nextIndex--
		}
		if p.nextIndex < 1 {
			p.nextIndex = 1
		}
		select {
		case p.notifyCh <- struct{}{}:
		default:
		}
	}
}

func (n *RaftNode) advanceCommitIndexLocked() {
	totalNodes := len(n.peers) + 1
	needed := totalNodes/2 + 1
	lastIdx := len(n.log) - 1

	for idx := lastIdx; idx > n.commitIndex; idx-- {
		if n.log[idx].Term != n.currentTerm {
			continue
		}
		count := 1 // self
		for _, p := range n.peers {
			if p.matchIndex >= idx {
				count++
			}
		}
		if count >= needed {
			n.commitIndex = idx
			n.notifyApplyLocked()
			break
		}
	}
}

func (n *RaftNode) applyLoop() {
	for {
		select {
		case <-n.stopCh:
			return
		case <-n.applyCh:
			n.mu.Lock()
			for n.appliedIndex < n.commitIndex && n.appliedIndex+1 < len(n.log) {
				n.appliedIndex++
				entry := n.log[n.appliedIndex]
				if entry.Key != "" {
					n.kv[entry.Key] = entry.Value
				}
				if ch, ok := n.waiters[entry.Index]; ok {
					select {
					case ch <- nil:
					default:
					}
					delete(n.waiters, entry.Index)
				}
			}
			n.mu.Unlock()
		}
	}
}

func (n *RaftNode) HandleRequestVote(req RequestVoteReq) RequestVoteResp {
	n.mu.Lock()
	defer n.mu.Unlock()

	if req.Term < n.currentTerm {
		return RequestVoteResp{Term: n.currentTerm, VoteGranted: false}
	}
	if req.Term > n.currentTerm {
		n.becomeFollowerLocked(req.Term, "")
	}

	lastIdx, lastTerm := n.lastLogIndexTermLocked()
	upToDate := req.LastLogTerm > lastTerm || (req.LastLogTerm == lastTerm && req.LastLogIndex >= lastIdx)

	granted := false
	if (n.votedFor == "" || n.votedFor == req.CandidateID) && upToDate {
		n.votedFor = req.CandidateID
		n.resetElectionDeadlineLocked()
		n.saveStateLocked()
		granted = true
		log.Printf("[raft:%s] voted for %s term=%d", n.cfg.ID, req.CandidateID, n.currentTerm)
	}
	return RequestVoteResp{Term: n.currentTerm, VoteGranted: granted}
}

func (n *RaftNode) HandleAppendEntries(req AppendEntriesReq) AppendEntriesResp {
	n.mu.Lock()
	defer n.mu.Unlock()

	if req.Term < n.currentTerm {
		return AppendEntriesResp{Term: n.currentTerm, Success: false}
	}

	if req.Term > n.currentTerm || n.role != RoleFollower {
		n.becomeFollowerLocked(req.Term, req.LeaderID)
	} else {
		n.leaderID = req.LeaderID
	}
	n.resetElectionDeadlineLocked()

	if req.PrevLogIndex >= len(n.log) {
		return AppendEntriesResp{
			Term:          n.currentTerm,
			Success:       false,
			ConflictIndex: len(n.log),
		}
	}
	if n.log[req.PrevLogIndex].Term != req.PrevLogTerm {
		conflictTerm := n.log[req.PrevLogIndex].Term
		conflictIdx := req.PrevLogIndex
		for conflictIdx > 1 && n.log[conflictIdx-1].Term == conflictTerm {
			conflictIdx--
		}
		return AppendEntriesResp{
			Term:          n.currentTerm,
			Success:       false,
			ConflictTerm:  conflictTerm,
			ConflictIndex: conflictIdx,
		}
	}

	changed := false
	for i, entry := range req.Entries {
		pos := req.PrevLogIndex + 1 + i
		if pos < len(n.log) {
			if n.log[pos].Term != entry.Term {
				n.log = n.log[:pos]
				n.log = append(n.log, entry)
				changed = true
			}
		} else {
			n.log = append(n.log, entry)
			changed = true
		}
	}
	if changed {
		n.saveStateLocked()
	}

	if req.LeaderCommit > n.commitIndex {
		lastNew := len(n.log) - 1
		if req.LeaderCommit < lastNew {
			n.commitIndex = req.LeaderCommit
		} else {
			n.commitIndex = lastNew
		}
		n.notifyApplyLocked()
	}

	return AppendEntriesResp{Term: n.currentTerm, Success: true}
}

func (n *RaftNode) Propose(key, value string, timeout time.Duration) (int, int, error) {
	n.mu.Lock()
	if n.role != RoleLeader {
		leader := n.leaderID
		role := n.role
		n.mu.Unlock()
		return 0, 0, fmt.Errorf("not leader (role=%s leader=%s)", role, leader)
	}
	idx := len(n.log)
	term := n.currentTerm
	n.log = append(n.log, LogEntry{
		Index: idx,
		Term:  term,
		Key:   key,
		Value: value,
	})
	n.saveStateLocked()
	ch := make(chan error, 1)
	n.waiters[idx] = ch
	n.notifyPeersLocked()
	n.mu.Unlock()

	timer := time.NewTimer(timeout)
	defer timer.Stop()

	select {
	case err := <-ch:
		return idx, term, err
	case <-timer.C:
		n.mu.Lock()
		delete(n.waiters, idx)
		n.mu.Unlock()
		return idx, term, fmt.Errorf("commit timeout (no quorum?)")
	case <-n.stopCh:
		return idx, term, fmt.Errorf("node stopped")
	}
}

func (n *RaftNode) GetKV(key string) (string, bool) {
	n.mu.Lock()
	defer n.mu.Unlock()
	v, ok := n.kv[key]
	return v, ok
}

func (n *RaftNode) AllKV() map[string]string {
	n.mu.Lock()
	defer n.mu.Unlock()
	out := make(map[string]string, len(n.kv))
	for k, v := range n.kv {
		out[k] = v
	}
	return out
}

func (n *RaftNode) Status() StatusSnapshot {
	n.mu.Lock()
	defer n.mu.Unlock()

	lastIdx, lastTerm := n.lastLogIndexTermLocked()
	peers := make(map[string]PeerStatus, len(n.peers))
	now := time.Now()
	for id, p := range n.peers {
		var lastContactMs int64 = -1
		if !p.lastContact.IsZero() {
			lastContactMs = now.Sub(p.lastContact).Milliseconds()
		}
		peers[id] = PeerStatus{
			Addr:          p.addr,
			NextIndex:     p.nextIndex,
			MatchIndex:    p.matchIndex,
			Connected:     p.connected,
			LastContactMs: lastContactMs,
			LastRttMs:     p.lastRttMs,
			LastError:     p.lastError,
		}
	}

	return StatusSnapshot{
		NodeID:       n.cfg.ID,
		PID:          os.Getpid(),
		Role:         n.role,
		Term:         n.currentTerm,
		LeaderID:     n.leaderID,
		VotedFor:     n.votedFor,
		CommitIndex:  n.commitIndex,
		AppliedIndex: n.appliedIndex,
		LastLogIndex: lastIdx,
		LastLogTerm:  lastTerm,
		KVCount:      len(n.kv),
		UptimeMs:     time.Since(n.startedAt).Milliseconds(),
		Peers:        peers,
	}
}
