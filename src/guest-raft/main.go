package main

import (
	"flag"
	"fmt"
	"log"
	"math/rand"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

func parsePeers(spec string) map[string]string {
	peers := make(map[string]string)
	for _, part := range strings.Split(spec, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		idx := strings.IndexByte(part, '=')
		if idx <= 0 || idx >= len(part)-1 {
			continue
		}
		id := strings.TrimSpace(part[:idx])
		addr := strings.TrimSpace(part[idx+1:])
		if id != "" && addr != "" {
			peers[id] = addr
		}
	}
	return peers
}

func main() {
	rand.Seed(time.Now().UnixNano() ^ int64(os.Getpid()))

	id := flag.String("id", "node-1", "unique node ID")
	listenAddr := flag.String("listen", "0.0.0.0:2380", "Raft TCP listen address")
	httpAddr := flag.String("http", "0.0.0.0:8080", "HTTP API listen address")
	peersSpec := flag.String("peers", "", "comma-separated id=host:port pairs")
	heartbeatMs := flag.Int("heartbeat", 150, "leader heartbeat interval in ms")
	electionMinMs := flag.Int("election-min", 1000, "minimum election timeout in ms")
	electionMaxMs := flag.Int("election-max", 1500, "maximum election timeout in ms")
	dataDir := flag.String("data-dir", "", "optional directory for Raft state persistence")
	flag.Parse()

	peers := parsePeers(*peersSpec)
	if len(peers) == 0 {
		log.Fatalf("no peers specified (use --peers=node-1=10.10.0.11:2380,...)")
	}
	if _, ok := peers[*id]; !ok {
		peers[*id] = *listenAddr
	}
	if *electionMaxMs <= *electionMinMs {
		*electionMaxMs = *electionMinMs + 400
	}

	cfg := RaftConfig{
		ID:            *id,
		ListenAddr:    *listenAddr,
		HTTPAddr:      *httpAddr,
		Peers:         peers,
		Heartbeat:     time.Duration(*heartbeatMs) * time.Millisecond,
		ElectionMin:   time.Duration(*electionMinMs) * time.Millisecond,
		ElectionMax:   time.Duration(*electionMaxMs) * time.Millisecond,
		DataDir:       *dataDir,
	}

	node, err := NewRaftNode(cfg)
	if err != nil {
		log.Fatalf("failed to create raft node: %v", err)
	}

	if err := node.Start(); err != nil {
		log.Fatalf("failed to start raft node: %v", err)
	}

	fmt.Printf("[raft-node] id=%s pid=%d raft=%s http=%s peers=%d\n",
		cfg.ID, os.Getpid(), cfg.ListenAddr, cfg.HTTPAddr, len(cfg.Peers))

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh
	node.Stop()
}
