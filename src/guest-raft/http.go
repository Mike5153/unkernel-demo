package main

import (
	"context"
	"encoding/json"
	"io/ioutil"
	"net/http"
	"time"
)

type HTTPServer struct {
	addr string
	node *RaftNode
	srv  *http.Server
}

func NewHTTPServer(addr string, node *RaftNode) *HTTPServer {
	return &HTTPServer{addr: addr, node: node}
}

func (h *HTTPServer) Start() error {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", h.handleHealth)
	mux.HandleFunc("/_chaos/status", h.handleStatus)
	mux.HandleFunc("/kv", h.handleKV)
	mux.HandleFunc("/kv/all", h.handleKVAll)

	h.srv = &http.Server{
		Addr:              h.addr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		if err := h.srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			errCh <- err
		}
	}()

	select {
	case err := <-errCh:
		return err
	case <-time.After(20 * time.Millisecond):
		return nil
	}
}

func (h *HTTPServer) Stop() {
	if h.srv == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	_ = h.srv.Shutdown(ctx)
}

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (h *HTTPServer) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true})
}

func (h *HTTPServer) handleStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, h.node.Status())
}

func (h *HTTPServer) handleKVAll(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]interface{}{
		"ok": true,
		"kv": h.node.AllKV(),
	})
}

func (h *HTTPServer) handleKV(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		key := r.URL.Query().Get("key")
		if key == "" {
			writeJSON(w, http.StatusBadRequest, map[string]interface{}{"ok": false, "error": "missing key"})
			return
		}
		val, ok := h.node.GetKV(key)
		if !ok {
			writeJSON(w, http.StatusNotFound, map[string]interface{}{"ok": false, "error": "not found"})
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{"ok": true, "key": key, "val": val})
		return
	}

	if r.Method != http.MethodPut && r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]interface{}{"ok": false, "error": "method not allowed"})
		return
	}

	key := r.URL.Query().Get("key")
	val := r.URL.Query().Get("val")
	if key == "" && r.Body != nil {
		body, _ := ioutil.ReadAll(r.Body)
		if len(body) > 0 {
			var payload struct {
				Key string `json:"key"`
				Val string `json:"val"`
			}
			if err := json.Unmarshal(body, &payload); err == nil {
				key = payload.Key
				val = payload.Val
			}
		}
	}
	if key == "" {
		writeJSON(w, http.StatusBadRequest, map[string]interface{}{"ok": false, "error": "missing key"})
		return
	}

	t0 := time.Now()
	idx, term, err := h.node.Propose(key, val, 2500*time.Millisecond)
	latencyMs := time.Since(t0).Milliseconds()
	if err != nil {
		st := h.node.Status()
		code := http.StatusServiceUnavailable
		if st.Role != RoleLeader {
			code = http.StatusConflict
		}
		writeJSON(w, code, map[string]interface{}{
			"ok":        false,
			"error":     err.Error(),
			"role":      st.Role,
			"leaderId":  st.LeaderID,
			"term":      st.Term,
			"latencyMs": latencyMs,
		})
		return
	}

	writeJSON(w, http.StatusOK, map[string]interface{}{
		"ok":        true,
		"key":       key,
		"val":       val,
		"index":     idx,
		"term":      term,
		"latencyMs": latencyMs,
	})
}
