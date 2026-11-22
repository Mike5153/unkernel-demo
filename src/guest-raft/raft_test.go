package main

import (
	"fmt"
	"net"
	"testing"
	"time"
)

func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("freePort: %v", err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

func TestThreeNodeElectionAndFailover(t *testing.T) {
	ids := []string{"node-1", "node-2", "node-3"}
	raftAddrs := map[string]string{}
	httpAddrs := map[string]string{}
	for _, id := range ids {
		raftAddrs[id] = fmt.Sprintf("127.0.0.1:%d", freePort(t))
		httpAddrs[id] = fmt.Sprintf("127.0.0.1:%d", freePort(t))
	}

	nodes := map[string]*RaftNode{}
	for _, id := range ids {
		cfg := RaftConfig{
			ID:          id,
			ListenAddr:  raftAddrs[id],
			HTTPAddr:    httpAddrs[id],
			Peers:       raftAddrs,
			Heartbeat:   40 * time.Millisecond,
			ElectionMin: 200 * time.Millisecond,
			ElectionMax: 350 * time.Millisecond,
		}
		n, err := NewRaftNode(cfg)
		if err != nil {
			t.Fatalf("NewRaftNode(%s): %v", id, err)
		}
		if err := n.Start(); err != nil {
			t.Fatalf("Start(%s): %v", id, err)
		}
		nodes[id] = n
	}
	defer func() {
		for _, n := range nodes {
			n.Stop()
		}
	}()

	findLeader := func(exclude string) *RaftNode {
		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			for id, n := range nodes {
				if id == exclude || n.isStopped() {
					continue
				}
				if n.Status().Role == RoleLeader {
					return n
				}
			}
			time.Sleep(30 * time.Millisecond)
		}
		return nil
	}

	leader := findLeader("")
	if leader == nil {
		t.Fatalf("no leader elected within 3s")
	}
	firstLeaderID := leader.Status().NodeID

	idx, term, err := leader.Propose("alpha", "123", 2*time.Second)
	if err != nil {
		t.Fatalf("Propose failed: %v", err)
	}
	if idx < 1 || term < 1 {
		t.Fatalf("unexpected idx=%d term=%d", idx, term)
	}

	// Verify replication to all nodes
	time.Sleep(150 * time.Millisecond)
	for id, n := range nodes {
		val, ok := n.GetKV("alpha")
		if !ok || val != "123" {
			t.Fatalf("node %s missing committed KV: ok=%v val=%q", id, ok, val)
		}
	}

	// Stop leader and verify remaining 2 nodes elect a new leader and accept writes
	leader.Stop()
	newLeader := findLeader(firstLeaderID)
	if newLeader == nil {
		t.Fatalf("no new leader elected after %s stopped", firstLeaderID)
	}
	if _, _, err := newLeader.Propose("beta", "456", 2*time.Second); err != nil {
		t.Fatalf("Propose on new leader %s failed: %v", newLeader.Status().NodeID, err)
	}
}
