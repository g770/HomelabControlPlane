// Copyright (c) 2026 Homelab Control Plane contributors
// SPDX-License-Identifier: MIT
//
// This Go source file implements server behavior for the lab agent.
package mcp

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"homelab/labagent/internal/config"
	"homelab/labagent/internal/logging"
	"homelab/labagent/internal/tools"
)

type Server struct {
	bindAddr       string
	port           int
	tokenMu        sync.RWMutex
	agentToken     string
	allowedOrigins map[string]struct{}
	executor       *tools.Executor
	httpServer     *http.Server
}

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      interface{}     `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}

type rpcResponse struct {
	JSONRPC string      `json:"jsonrpc"`
	ID      interface{} `json:"id"`
	Result  interface{} `json:"result,omitempty"`
	Error   *rpcError   `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

const (
	defaultRPCTimeout          = 20 * time.Second
	subnetToolCallTimeoutMinMs = int64(5_000)
	subnetToolCallTimeoutMaxMs = int64(600_000)
)

var runtimeLogger *logging.Logger

// SetLogger implements set logger.
func SetLogger(logger *logging.Logger) {
	runtimeLogger = logger
}

// logInfo implements log info.
func logInfo(message string, attrs ...slog.Attr) {
	if runtimeLogger != nil {
		runtimeLogger.Info(message, attrs...)
		return
	}
	slog.Info(message, attrsToAny(attrs)...)
}

// logWarn implements log warn.
func logWarn(message string, attrs ...slog.Attr) {
	if runtimeLogger != nil {
		runtimeLogger.Warn(message, attrs...)
		return
	}
	slog.Warn(message, attrsToAny(attrs)...)
}

// NewServer implements new server.
func NewServer(bindAddr string, port int, agentToken string, allowedOrigins []string, executor *tools.Executor) *Server {
	originSet := map[string]struct{}{}
	for _, origin := range allowedOrigins {
		trimmed := strings.TrimSpace(origin)
		if trimmed != "" {
			originSet[trimmed] = struct{}{}
		}
	}
	return &Server{
		bindAddr:       bindAddr,
		port:           port,
		agentToken:     agentToken,
		allowedOrigins: originSet,
		executor:       executor,
	}
}

// Start implements start.
func (s *Server) Start() error {
	mux := http.NewServeMux()
	mux.HandleFunc("/mcp", s.handleMCP)

	addr := fmt.Sprintf("%s:%d", s.bindAddr, s.port)
	s.httpServer = &http.Server{
		Addr:              addr,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		if err := s.httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			logWarn("mcp server error", slog.String("reason", err.Error()))
		}
	}()
	logInfo("mcp server listening", slog.String("address", addr))
	return nil
}

// Shutdown implements shutdown.
func (s *Server) Shutdown(ctx context.Context) error {
	if s.httpServer == nil {
		return nil
	}
	return s.httpServer.Shutdown(ctx)
}

// SetAgentToken implements set agent token.
func (s *Server) SetAgentToken(token string) {
	s.tokenMu.Lock()
	defer s.tokenMu.Unlock()
	s.agentToken = token
}

// handleMCP handles mcp.
func (s *Server) handleMCP(w http.ResponseWriter, r *http.Request) {
	if !s.validateOrigin(r) {
		http.Error(w, "forbidden origin", http.StatusForbidden)
		return
	}
	if !s.validateAuth(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	if r.Method == http.MethodGet {
		s.handleGet(w)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	defer r.Body.Close()
	var req rpcRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		s.writeRPCError(w, nil, -32700, "invalid JSON")
		return
	}

	if req.JSONRPC == "" {
		req.JSONRPC = "2.0"
	}

	switch req.Method {
	case "initialize":
		s.writeRPCResult(w, req.ID, map[string]interface{}{
			"name":    "labagent-mcp",
			"version": config.Version,
			"capabilities": map[string]interface{}{
				"tools":     true,
				"resources": true,
				"prompts":   true,
			},
		})
	case "resources/list":
		s.writeRPCResult(w, req.ID, map[string]interface{}{
			"resources": s.executor.ListResources(),
		})
	case "resources/read":
		var params struct {
			URI string `json:"uri"`
		}
		_ = json.Unmarshal(req.Params, &params)
		result, err := s.executor.GetResource(params.URI)
		if err != nil {
			s.writeRPCError(w, req.ID, -32000, err.Error())
			return
		}
		s.writeRPCResult(w, req.ID, result)
	case "tools/list":
		s.writeRPCResult(w, req.ID, map[string]interface{}{
			"tools": s.executor.ListTools(),
		})
	case "tools/call":
		var params struct {
			Name      string                 `json:"name"`
			Arguments map[string]interface{} `json:"arguments"`
		}
		if err := json.Unmarshal(req.Params, &params); err != nil {
			s.writeRPCError(w, req.ID, -32602, "invalid tool call params")
			return
		}
		if params.Arguments == nil {
			params.Arguments = map[string]interface{}{}
		}
		timeout := resolveToolCallTimeout(params.Name, params.Arguments)
		ctx, cancel := context.WithTimeout(r.Context(), timeout)
		defer cancel()
		result, err := s.executor.CallTool(ctx, params.Name, params.Arguments)
		if err != nil {
			s.writeRPCError(w, req.ID, -32001, err.Error())
			return
		}
		s.writeRPCResult(w, req.ID, result)
	case "prompts/list":
		s.writeRPCResult(w, req.ID, map[string]interface{}{
			"prompts": s.executor.ListPrompts(),
		})
	case "prompts/get":
		var params struct {
			Name string `json:"name"`
		}
		_ = json.Unmarshal(req.Params, &params)
		s.writeRPCResult(w, req.ID, map[string]interface{}{
			"name":    params.Name,
			"content": promptContent(params.Name),
		})
	default:
		s.writeRPCError(w, req.ID, -32601, "method not found")
	}
}

// resolveToolCallTimeout implements resolve tool call timeout.
func resolveToolCallTimeout(name string, arguments map[string]interface{}) time.Duration {
	timeout := defaultRPCTimeout
	if !strings.EqualFold(strings.TrimSpace(name), "network.scan_known_services") {
		return timeout
	}
	raw, exists := arguments["toolCallTimeoutMs"]
	if !exists {
		return timeout
	}
	parsedMs, ok := parseTimeoutMs(raw)
	if !ok {
		return timeout
	}
	if parsedMs < subnetToolCallTimeoutMinMs {
		parsedMs = subnetToolCallTimeoutMinMs
	}
	if parsedMs > subnetToolCallTimeoutMaxMs {
		parsedMs = subnetToolCallTimeoutMaxMs
	}
	return time.Duration(parsedMs) * time.Millisecond
}

// parseTimeoutMs parses timeout ms.
func parseTimeoutMs(raw interface{}) (int64, bool) {
	switch value := raw.(type) {
	case float64:
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return 0, false
		}
		return int64(math.Round(value)), true
	case int:
		return int64(value), true
	case int32:
		return int64(value), true
	case int64:
		return value, true
	case string:
		trimmed := strings.TrimSpace(value)
		if trimmed == "" {
			return 0, false
		}
		parsed, err := strconv.ParseInt(trimmed, 10, 64)
		if err != nil {
			return 0, false
		}
		return parsed, true
	default:
		return 0, false
	}
}

// attrsToAny implements attrs to any.
func attrsToAny(attrs []slog.Attr) []any {
	items := make([]any, 0, len(attrs))
	for _, attr := range attrs {
		items = append(items, attr)
	}
	return items
}

// promptContent implements prompt content.
func promptContent(name string) string {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case strings.ToLower("Diagnose high CPU"):
		return "1) Inspect host.status and host://metrics/summary\n2) Check services.list\n3) Tail relevant logs via logs.tail"
	case strings.ToLower("Investigate disk pressure"):
		return "1) Run storage.df\n2) Inspect top mounts from host://facts\n3) Tail storage service logs"
	case strings.ToLower("Why is service unhealthy?"):
		return "1) services.list\n2) logs.tail for service\n3) network.ping dependencies"
	case strings.ToLower("Prepare maintenance plan"):
		return "1) Gather status\n2) Propose action\n3) Require approval\n4) Execute and verify"
	default:
		return "Prompt not found"
	}
}

// handleGet handles get.
func (s *Server) handleGet(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"name":      "labagent-mcp",
		"version":   config.Version,
		"resources": s.executor.ListResources(),
		"tools":     s.executor.ListTools(),
		"prompts":   s.executor.ListPrompts(),
	})
}

// validateOrigin implements validate origin.
func (s *Server) validateOrigin(r *http.Request) bool {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		return true
	}
	_, ok := s.allowedOrigins[origin]
	return ok
}

// validateAuth implements validate auth.
func (s *Server) validateAuth(r *http.Request) bool {
	header := strings.TrimSpace(r.Header.Get("Authorization"))
	if header == "" {
		return false
	}
	parts := strings.SplitN(header, " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return false
	}
	token := parts[1]
	currentToken := s.currentAgentToken()
	if len(token) == 0 || len(currentToken) == 0 {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(token), []byte(currentToken)) == 1
}

// currentAgentToken implements current agent token.
func (s *Server) currentAgentToken() string {
	s.tokenMu.RLock()
	defer s.tokenMu.RUnlock()
	return s.agentToken
}

// writeRPCResult implements write rpcresult.
func (s *Server) writeRPCResult(w http.ResponseWriter, id interface{}, result interface{}) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(rpcResponse{
		JSONRPC: "2.0",
		ID:      id,
		Result:  result,
	})
}

// writeRPCError implements write rpcerror.
func (s *Server) writeRPCError(w http.ResponseWriter, id interface{}, code int, message string) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(rpcResponse{
		JSONRPC: "2.0",
		ID:      id,
		Error: &rpcError{
			Code:    code,
			Message: message,
		},
	})
}
