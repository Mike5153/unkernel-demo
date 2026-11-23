package main

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"sync"
	"time"
)

type wireEnvelope struct {
	Type string          `json:"type"`
	Body json.RawMessage `json:"body"`
}

type peerConn struct {
	mu   sync.Mutex
	conn net.Conn
}

type Transport struct {
	addr     string
	node     *RaftNode
	listener net.Listener

	mu    sync.Mutex
	conns map[string]*peerConn
	closed bool
}

func NewTransport(addr string, node *RaftNode) *Transport {
	return &Transport{
		addr:  addr,
		node:  node,
		conns: make(map[string]*peerConn),
	}
}

func (t *Transport) Start() error {
	ln, err := net.Listen("tcp", t.addr)
	if err != nil {
		return err
	}
	t.listener = ln
	go t.acceptLoop()
	return nil
}

func (t *Transport) Stop() {
	t.mu.Lock()
	t.closed = true
	if t.listener != nil {
		_ = t.listener.Close()
	}
	for _, pc := range t.conns {
		pc.mu.Lock()
		if pc.conn != nil {
			_ = pc.conn.Close()
			pc.conn = nil
		}
		pc.mu.Unlock()
	}
	t.mu.Unlock()
}

func (t *Transport) acceptLoop() {
	for {
		conn, err := t.listener.Accept()
		if err != nil {
			t.mu.Lock()
			closed := t.closed
			t.mu.Unlock()
			if closed {
				return
			}
			time.Sleep(20 * time.Millisecond)
			continue
		}
		go t.handleConn(conn)
	}
}

func (t *Transport) handleConn(conn net.Conn) {
	defer conn.Close()
	if tc, ok := conn.(*net.TCPConn); ok {
		_ = tc.SetNoDelay(true)
	}
	for {
		_ = conn.SetReadDeadline(time.Now().Add(30 * time.Second))
		env, err := readFrame(conn)
		if err != nil {
			return
		}
		var respType string
		var respBody interface{}

		switch env.Type {
		case "rv":
			var req RequestVoteReq
			if err := json.Unmarshal(env.Body, &req); err != nil {
				return
			}
			respType = "rv_resp"
			respBody = t.node.HandleRequestVote(req)
		case "ae":
			var req AppendEntriesReq
			if err := json.Unmarshal(env.Body, &req); err != nil {
				return
			}
			respType = "ae_resp"
			respBody = t.node.HandleAppendEntries(req)
		default:
			return
		}

		_ = conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
		if err := writeFrame(conn, respType, respBody); err != nil {
			return
		}
	}
}

func (t *Transport) getPeerConn(peerID string) *peerConn {
	t.mu.Lock()
	defer t.mu.Unlock()
	pc, ok := t.conns[peerID]
	if !ok {
		pc = &peerConn{}
		t.conns[peerID] = pc
	}
	return pc
}

func (t *Transport) SendAppendEntries(peerID, addr string, req AppendEntriesReq, timeout time.Duration) (AppendEntriesResp, error) {
	var resp AppendEntriesResp
	pc := t.getPeerConn(peerID)
	pc.mu.Lock()
	defer pc.mu.Unlock()

	if err := t.callOnConn(pc, addr, "ae", req, &resp, timeout); err != nil {
		return resp, err
	}
	return resp, nil
}

func (t *Transport) SendRequestVote(peerID, addr string, req RequestVoteReq, timeout time.Duration) (RequestVoteResp, error) {
	var resp RequestVoteResp
	pc := &peerConn{}
	if err := t.callOnConn(pc, addr, "rv", req, &resp, timeout); err != nil {
		return resp, err
	}
	if pc.conn != nil {
		_ = pc.conn.Close()
	}
	return resp, nil
}

func (t *Transport) callOnConn(pc *peerConn, addr, msgType string, req interface{}, respOut interface{}, timeout time.Duration) error {
	if pc.conn == nil {
		dialTimeout := timeout
		if dialTimeout > 600*time.Millisecond {
			dialTimeout = 600 * time.Millisecond
		}
		c, err := net.DialTimeout("tcp", addr, dialTimeout)
		if err != nil {
			return err
		}
		if tc, ok := c.(*net.TCPConn); ok {
			_ = tc.SetNoDelay(true)
		}
		pc.conn = c
	}

	_ = pc.conn.SetDeadline(time.Now().Add(timeout))
	if err := writeFrame(pc.conn, msgType, req); err != nil {
		_ = pc.conn.Close()
		pc.conn = nil
		return err
	}
	env, err := readFrame(pc.conn)
	if err != nil {
		_ = pc.conn.Close()
		pc.conn = nil
		return err
	}
	if err := json.Unmarshal(env.Body, respOut); err != nil {
		_ = pc.conn.Close()
		pc.conn = nil
		return err
	}
	return nil
}

func writeFrame(w io.Writer, msgType string, payload interface{}) error {
	bodyBytes, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	env := wireEnvelope{
		Type: msgType,
		Body: json.RawMessage(bodyBytes),
	}
	data, err := json.Marshal(env)
	if err != nil {
		return err
	}
	var hdr [4]byte
	binary.BigEndian.PutUint32(hdr[:], uint32(len(data)))
	if _, err := w.Write(hdr[:]); err != nil {
		return err
	}
	_, err = w.Write(data)
	return err
}

func readFrame(r io.Reader) (wireEnvelope, error) {
	var env wireEnvelope
	var hdr [4]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return env, err
	}
	length := binary.BigEndian.Uint32(hdr[:])
	if length == 0 || length > 4*1024*1024 {
		return env, fmt.Errorf("invalid frame length %d", length)
	}
	buf := make([]byte, length)
	if _, err := io.ReadFull(r, buf); err != nil {
		return env, err
	}
	if err := json.Unmarshal(buf, &env); err != nil {
		return env, err
	}
	return env, nil
}
