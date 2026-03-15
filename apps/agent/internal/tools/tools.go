// Copyright (c) 2026 Homelab Control Plane contributors
// SPDX-License-Identifier: MIT
//
// This Go source file implements tools behavior for the lab agent.
package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"homelab/labagent/internal/redact"
)

// Command/input validators used by write and diagnostic tools.
var (
	serviceNamePattern    = regexp.MustCompile(`^[a-zA-Z0-9@._-]+(\.service)?$`)
	containerIDPattern    = regexp.MustCompile(`^[a-zA-Z0-9_.-]{1,128}$`)
	composeProjectPattern = regexp.MustCompile(`^[a-zA-Z0-9_.-]{1,128}$`)
	pathAllowedPattern    = regexp.MustCompile(`^(/var/log/|/tmp/)`)
)

// RuntimeState stores recent host facts/inventory snapshots for read tools.
type RuntimeState struct {
	mu           sync.RWMutex
	facts        map[string]interface{}
	inventory    map[string]interface{}
	recentEvents []map[string]interface{}
}

// TelemetryConfig is the runtime collection interval state surfaced to MCP.
type TelemetryConfig struct {
	HeartbeatSec int
	FactsSec     int
	InventorySec int
	MinSec       int
	MaxSec       int
	UpdatedAt    string
}

// TelemetryConfigPatch is a partial update request for interval values.
type TelemetryConfigPatch struct {
	HeartbeatSec *int
	FactsSec     *int
	InventorySec *int
}

// TelemetryHooks lets the executor read/update runtime collection behavior.
type TelemetryHooks struct {
	GetConfig      func() TelemetryConfig
	SetConfig      func(patch TelemetryConfigPatch) (TelemetryConfig, error)
	RequestRefresh func(reason string) bool
}

// NewRuntimeState creates an empty in-memory runtime cache.
func NewRuntimeState() *RuntimeState {
	return &RuntimeState{
		facts:        map[string]interface{}{},
		inventory:    map[string]interface{}{},
		recentEvents: []map[string]interface{}{},
	}
}

// UpdateFacts replaces the current facts snapshot atomically.
func (s *RuntimeState) UpdateFacts(facts map[string]interface{}) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.facts = facts
}

// UpdateInventory replaces the current inventory snapshot atomically.
func (s *RuntimeState) UpdateInventory(inventory map[string]interface{}) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.inventory = inventory
}

// AppendEvents appends and trims recent events to a bounded window.
func (s *RuntimeState) AppendEvents(events []map[string]interface{}) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.recentEvents = append(s.recentEvents, events...)
	if len(s.recentEvents) > 200 {
		s.recentEvents = s.recentEvents[len(s.recentEvents)-200:]
	}
}

// Snapshot returns deep copies so callers cannot mutate shared runtime state.
func (s *RuntimeState) Snapshot() (map[string]interface{}, map[string]interface{}, []map[string]interface{}) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	factsCopy := deepCopyMap(s.facts)
	inventoryCopy := deepCopyMap(s.inventory)
	eventsCopy := make([]map[string]interface{}, len(s.recentEvents))
	for i, event := range s.recentEvents {
		eventsCopy[i] = deepCopyMap(event)
	}
	return factsCopy, inventoryCopy, eventsCopy
}

// deepCopyMap performs a best-effort deep copy for map/list telemetry values.
func deepCopyMap(input map[string]interface{}) map[string]interface{} {
	output := map[string]interface{}{}
	for k, v := range input {
		switch tv := v.(type) {
		case map[string]interface{}:
			output[k] = deepCopyMap(tv)
		case []string:
			output[k] = copyStringSlice(tv)
		case []map[string]interface{}:
			copied := make([]map[string]interface{}, len(tv))
			for i := range tv {
				copied[i] = deepCopyMap(tv[i])
			}
			output[k] = copied
		case []interface{}:
			copied := make([]interface{}, len(tv))
			copy(copied, tv)
			output[k] = copied
		default:
			output[k] = v
		}
	}
	return output
}

// copyStringSlice implements copy string slice.
func copyStringSlice(values []string) []string {
	if len(values) == 0 {
		return []string{}
	}
	copied := make([]string, len(values))
	copy(copied, values)
	return copied
}

// Executor exposes MCP-style tools/resources over a shared runtime snapshot.
type Executor struct {
	state          *RuntimeState
	telemetryHooks TelemetryHooks
	subnetScanMu   sync.Mutex
	subnetScanJobs map[string]*subnetScanJob
	activeSubnetID string
}

// NewExecutor constructs an executor backed by the given runtime state.
func NewExecutor(state *RuntimeState, hooks ...TelemetryHooks) *Executor {
	executor := &Executor{
		state:          state,
		subnetScanJobs: map[string]*subnetScanJob{},
	}
	if len(hooks) > 0 {
		executor.telemetryHooks = hooks[0]
	}
	return executor
}

const (
	subnetScanJobRetention       = 15 * time.Minute
	subnetScanToolTimeoutDefault = 120_000
	subnetScanToolTimeoutMin     = 5_000
	subnetScanToolTimeoutMax     = 600_000
)

type subnetScanJobState string

const (
	subnetScanJobStateRunning   subnetScanJobState = "RUNNING"
	subnetScanJobStateCompleted subnetScanJobState = "COMPLETED"
	subnetScanJobStateFailed    subnetScanJobState = "FAILED"
)

type subnetScanJob struct {
	ID         string
	State      subnetScanJobState
	StartedAt  time.Time
	UpdatedAt  time.Time
	FinishedAt *time.Time
	ExpiresAt  time.Time
	Error      string
	Result     map[string]interface{}
	Progress   subnetScanJobProgress
}

type subnetScanJobProgress struct {
	CIDRs          []string
	HostsPlanned   int
	HostsScanned   int
	HostsReachable int
	Detections     int
	Warnings       []string
}

// clone implements clone.
func (p subnetScanJobProgress) clone() subnetScanJobProgress {
	return subnetScanJobProgress{
		CIDRs:          copyStringSlice(p.CIDRs),
		HostsPlanned:   p.HostsPlanned,
		HostsScanned:   p.HostsScanned,
		HostsReachable: p.HostsReachable,
		Detections:     p.Detections,
		Warnings:       copyStringSlice(p.Warnings),
	}
}

// ListTools advertises supported read/write tool metadata to the control plane.
func (e *Executor) ListTools() []map[string]interface{} {
	return []map[string]interface{}{
		{"name": "host.status", "description": "Host status snapshot", "mode": "read"},
		{"name": "process.snapshot", "description": "Bounded process snapshot for discovery", "mode": "read"},
		{"name": "service.probe", "description": "Allowlisted local service probe (http/https/tcp)", "mode": "read"},
		{"name": "terminal.exec", "description": "Run allowlisted terminal diagnostics", "mode": "read"},
		{"name": "agent.telemetry.get_config", "description": "Read telemetry collection intervals", "mode": "read"},
		{"name": "agent.telemetry.set_config", "description": "Update telemetry collection intervals", "mode": "write"},
		{"name": "agent.telemetry.refresh_now", "description": "Request immediate telemetry refresh", "mode": "write"},
		{"name": "services.list", "description": "Systemd service summary", "mode": "read"},
		{"name": "containers.list", "description": "Docker container summary", "mode": "read"},
		{"name": "logs.tail", "description": "Tail logs with redaction", "mode": "read", "sensitiveRead": true},
		{"name": "network.ping", "description": "Ping target", "mode": "read"},
		{"name": "network.traceroute", "description": "Traceroute target", "mode": "read"},
		{"name": "network.scan_known_services", "description": "Bounded subnet scan using known service probes", "mode": "read"},
		{"name": "network.scan_known_services.start", "description": "Start async bounded subnet scan using known service probes", "mode": "read"},
		{"name": "network.scan_known_services.status", "description": "Read async subnet scan status", "mode": "read"},
		{"name": "network.scan_known_services.result", "description": "Read async subnet scan result", "mode": "read"},
		{"name": "storage.df", "description": "Disk usage summary", "mode": "read"},
		{"name": "services.restart", "description": "Restart systemd service", "mode": "write"},
		{"name": "containers.restart", "description": "Restart docker container", "mode": "write"},
		{"name": "compose.redeploy", "description": "Redeploy docker compose project", "mode": "write"},
		{"name": "host.reboot", "description": "Reboot host", "mode": "write", "highRisk": true},
	}
}

// ListResources describes read-only resources available from runtime snapshots.
func (e *Executor) ListResources() []map[string]interface{} {
	return []map[string]interface{}{
		{"uri": "host://facts", "name": "Host facts"},
		{"uri": "host://services", "name": "System services"},
		{"uri": "host://containers", "name": "Containers"},
		{"uri": "host://metrics/summary", "name": "Metrics summary"},
		{"uri": "host://events/recent", "name": "Recent events"},
	}
}

// ListPrompts returns canned troubleshooting prompt templates.
func (e *Executor) ListPrompts() []map[string]interface{} {
	return []map[string]interface{}{
		{"name": "Diagnose high CPU", "description": "Guide for CPU pressure diagnostics"},
		{"name": "Investigate disk pressure", "description": "Guide for disk usage analysis"},
		{"name": "Why is service unhealthy?", "description": "Guide for service triage"},
		{"name": "Prepare maintenance plan", "description": "Guide for safe maintenance planning"},
	}
}

// GetResource resolves a resource URI to its current snapshot payload.
func (e *Executor) GetResource(uri string) (map[string]interface{}, error) {
	facts, inventory, events := e.state.Snapshot()
	switch uri {
	case "host://facts":
		return map[string]interface{}{"uri": uri, "data": facts}, nil
	case "host://services":
		return map[string]interface{}{"uri": uri, "data": inventory["services"]}, nil
	case "host://containers":
		return map[string]interface{}{"uri": uri, "data": inventory["containers"]}, nil
	case "host://metrics/summary":
		metrics := map[string]interface{}{
			"cpuPct":  facts["cpuPct"],
			"memPct":  facts["memPct"],
			"diskPct": facts["diskPct"],
		}
		return map[string]interface{}{"uri": uri, "data": metrics}, nil
	case "host://events/recent":
		return map[string]interface{}{"uri": uri, "data": events}, nil
	default:
		return nil, fmt.Errorf("unknown resource: %s", uri)
	}
}

// CallTool dispatches tool invocations to allowlisted implementations.
func (e *Executor) CallTool(ctx context.Context, name string, args map[string]interface{}) (map[string]interface{}, error) {
	switch name {
	case "host.status":
		return e.toolHostStatus(), nil
	case "process.snapshot":
		return e.toolProcessSnapshot(ctx, args)
	case "service.probe":
		return e.toolServiceProbe(ctx, args)
	case "terminal.exec":
		return e.toolTerminalExec(ctx, args)
	case "agent.telemetry.get_config":
		return e.toolTelemetryGetConfig()
	case "agent.telemetry.set_config":
		return e.toolTelemetrySetConfig(args)
	case "agent.telemetry.refresh_now":
		return e.toolTelemetryRefreshNow(args)
	case "services.list":
		return e.toolServicesList(), nil
	case "containers.list":
		return e.toolContainersList(), nil
	case "logs.tail":
		return e.toolLogsTail(ctx, args)
	case "network.ping":
		return e.toolNetworkPing(ctx, args)
	case "network.traceroute":
		return e.toolNetworkTraceroute(ctx, args)
	case "network.scan_known_services":
		return e.toolNetworkScanKnownServices(ctx, args)
	case "network.scan_known_services.start":
		return e.toolNetworkScanKnownServicesStart(args)
	case "network.scan_known_services.status":
		return e.toolNetworkScanKnownServicesStatus(args)
	case "network.scan_known_services.result":
		return e.toolNetworkScanKnownServicesResult(args)
	case "storage.df":
		return e.toolStorageDF(ctx)
	case "services.restart":
		return e.toolServiceRestart(ctx, args)
	case "containers.restart":
		return e.toolContainerRestart(ctx, args)
	case "compose.redeploy":
		return e.toolComposeRedeploy(ctx, args)
	case "host.reboot":
		return e.toolHostReboot(ctx, args)
	default:
		return nil, fmt.Errorf("unknown tool: %s", name)
	}
}

// toolHostStatus returns a compact status view used by AI and diagnostics.
func (e *Executor) toolHostStatus() map[string]interface{} {
	facts, inventory, events := e.state.Snapshot()
	return map[string]interface{}{
		"hostname":     facts["hostname"],
		"cpuPct":       facts["cpuPct"],
		"memPct":       facts["memPct"],
		"diskPct":      facts["diskPct"],
		"services":     inventory["services"],
		"recentEvents": events,
		"timestamp":    time.Now().UTC().Format(time.RFC3339),
	}
}

// toolTelemetryGetConfig implements tool telemetry get config.
func (e *Executor) toolTelemetryGetConfig() (map[string]interface{}, error) {
	if e.telemetryHooks.GetConfig == nil {
		return nil, errors.New("telemetry config is not available")
	}
	config := e.telemetryHooks.GetConfig()
	return map[string]interface{}{
		"ok":     true,
		"config": telemetryConfigMap(config),
	}, nil
}

// toolTelemetrySetConfig implements tool telemetry set config.
func (e *Executor) toolTelemetrySetConfig(args map[string]interface{}) (map[string]interface{}, error) {
	if e.telemetryHooks.SetConfig == nil {
		return nil, errors.New("telemetry config updates are not available")
	}
	confirm, _ := args["confirm"].(bool)
	if !confirm {
		return nil, errors.New("agent.telemetry.set_config requires confirm=true")
	}

	patch := TelemetryConfigPatch{}
	hasUpdate := false

	if value, ok := intPtrArg(args, "heartbeatSec"); ok {
		patch.HeartbeatSec = &value
		hasUpdate = true
	}
	if value, ok := intPtrArg(args, "factsSec"); ok {
		patch.FactsSec = &value
		hasUpdate = true
	}
	if value, ok := intPtrArg(args, "inventorySec"); ok {
		patch.InventorySec = &value
		hasUpdate = true
	}

	if !hasUpdate {
		return nil, errors.New("at least one of heartbeatSec, factsSec, inventorySec must be provided")
	}

	updated, err := e.telemetryHooks.SetConfig(patch)
	if err != nil {
		return nil, err
	}

	return map[string]interface{}{
		"ok":     true,
		"config": telemetryConfigMap(updated),
	}, nil
}

// toolTelemetryRefreshNow implements tool telemetry refresh now.
func (e *Executor) toolTelemetryRefreshNow(args map[string]interface{}) (map[string]interface{}, error) {
	if e.telemetryHooks.RequestRefresh == nil {
		return nil, errors.New("telemetry refresh is not available")
	}
	confirm, _ := args["confirm"].(bool)
	if !confirm {
		return nil, errors.New("agent.telemetry.refresh_now requires confirm=true")
	}
	reason := stringArg(args, "reason", "manual")
	queued := e.telemetryHooks.RequestRefresh(reason)
	return map[string]interface{}{
		"ok":          true,
		"queued":      queued,
		"reason":      reason,
		"requestedAt": time.Now().UTC().Format(time.RFC3339),
	}, nil
}

// telemetryConfigMap implements telemetry config map.
func telemetryConfigMap(config TelemetryConfig) map[string]interface{} {
	return map[string]interface{}{
		"heartbeatSec": config.HeartbeatSec,
		"factsSec":     config.FactsSec,
		"inventorySec": config.InventorySec,
		"minSec":       config.MinSec,
		"maxSec":       config.MaxSec,
		"updatedAt":    config.UpdatedAt,
	}
}

// toolProcessSnapshot implements tool process snapshot.
func (e *Executor) toolProcessSnapshot(ctx context.Context, args map[string]interface{}) (map[string]interface{}, error) {
	limit := intArg(args, "limit", 200)
	if limit < 1 {
		limit = 1
	}
	if limit > 500 {
		limit = 500
	}

	cmd := exec.CommandContext(ctx, "ps", "-eo", "pid=,comm=,args=")
	stdout, stderr, err := runCommandCapture(cmd)
	if err != nil {
		redacted, _ := redact.RedactString(strings.TrimSpace(stdout + "\n" + stderr))
		return map[string]interface{}{
			"ok":        false,
			"error":     redacted,
			"processes": []map[string]interface{}{},
		}, nil
	}

	lines := strings.Split(stdout, "\n")
	processes := make([]map[string]interface{}, 0, len(lines))
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}
		parts := strings.Fields(trimmed)
		if len(parts) < 2 {
			continue
		}
		pid, parseErr := strconv.Atoi(parts[0])
		if parseErr != nil {
			continue
		}
		name := parts[1]
		command := ""
		if len(parts) > 2 {
			rawCommand := strings.Join(parts[2:], " ")
			redacted, _ := redact.RedactString(rawCommand)
			command = redacted
		}
		processes = append(processes, map[string]interface{}{
			"pid":     pid,
			"name":    name,
			"command": command,
		})
		if len(processes) >= limit {
			break
		}
	}

	return map[string]interface{}{
		"ok":        true,
		"count":     len(processes),
		"processes": processes,
	}, nil
}

// toolServiceProbe implements tool service probe.
func (e *Executor) toolServiceProbe(ctx context.Context, args map[string]interface{}) (map[string]interface{}, error) {
	protocol := strings.ToLower(stringArg(args, "protocol", "http"))
	if protocol != "http" && protocol != "https" && protocol != "tcp" {
		return nil, errors.New("protocol must be one of: http, https, tcp")
	}

	port := intArg(args, "port", 0)
	if port < 1 || port > 65535 {
		return nil, errors.New("port must be between 1 and 65535")
	}

	timeoutMs := intArg(args, "timeoutMs", 2500)
	if timeoutMs < 100 {
		timeoutMs = 100
	}
	if timeoutMs > 10_000 {
		timeoutMs = 10_000
	}

	target := stringArg(args, "target", "")
	if target == "" {
		target = "127.0.0.1"
	}
	if !e.isAllowedLocalTarget(target) {
		return nil, errors.New("target must resolve to the local host")
	}

	path := stringArg(args, "path", "/")
	if path == "" {
		path = "/"
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	if len(path) > 256 {
		return nil, errors.New("path is too long")
	}

	expectedStatusCodes := intSliceArg(args, "expect.statusCodes", 12)
	bodyContains := stringSliceArg(args, "expect.bodyContains", 12, 120)
	headersContain := stringSliceArg(args, "expect.headersContain", 12, 120)

	if protocol == "tcp" {
		start := time.Now()
		dialer := net.Dialer{Timeout: time.Duration(timeoutMs) * time.Millisecond}
		conn, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort(target, strconv.Itoa(port)))
		if err != nil {
			return map[string]interface{}{
				"ok":        false,
				"protocol":  protocol,
				"target":    target,
				"port":      port,
				"reachable": false,
				"latencyMs": time.Since(start).Milliseconds(),
				"error":     err.Error(),
			}, nil
		}
		_ = conn.Close()
		return map[string]interface{}{
			"ok":        true,
			"protocol":  protocol,
			"target":    target,
			"port":      port,
			"reachable": true,
			"latencyMs": time.Since(start).Milliseconds(),
		}, nil
	}

	scheme := protocol
	base := fmt.Sprintf("%s://%s:%d%s", scheme, target, port, path)
	parsedURL, err := url.Parse(base)
	if err != nil {
		return nil, errors.New("invalid probe url")
	}

	start := time.Now()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, parsedURL.String(), nil)
	if err != nil {
		return nil, errors.New("failed to build probe request")
	}
	client := &http.Client{
		Timeout: time.Duration(timeoutMs) * time.Millisecond,
	}
	resp, err := client.Do(req)
	if err != nil {
		return map[string]interface{}{
			"ok":        false,
			"protocol":  protocol,
			"target":    target,
			"port":      port,
			"path":      path,
			"reachable": false,
			"latencyMs": time.Since(start).Milliseconds(),
			"error":     err.Error(),
		}, nil
	}
	defer resp.Body.Close()

	bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 32*1024))
	bodyText := strings.ToLower(string(bodyBytes))
	headerText := strings.ToLower(flattenHeaderMap(resp.Header))

	statusMatch := len(expectedStatusCodes) == 0
	if len(expectedStatusCodes) > 0 {
		for _, status := range expectedStatusCodes {
			if resp.StatusCode == status {
				statusMatch = true
				break
			}
		}
	}

	bodyMatch := len(bodyContains) == 0
	if len(bodyContains) > 0 {
		bodyMatch = true
		for _, needle := range bodyContains {
			if !strings.Contains(bodyText, strings.ToLower(needle)) {
				bodyMatch = false
				break
			}
		}
	}

	headerMatch := len(headersContain) == 0
	if len(headersContain) > 0 {
		headerMatch = true
		for _, needle := range headersContain {
			if !strings.Contains(headerText, strings.ToLower(needle)) {
				headerMatch = false
				break
			}
		}
	}

	ok := statusMatch && bodyMatch && headerMatch
	return map[string]interface{}{
		"ok":         ok,
		"protocol":   protocol,
		"target":     target,
		"port":       port,
		"path":       path,
		"url":        parsedURL.String(),
		"reachable":  true,
		"statusCode": resp.StatusCode,
		"latencyMs":  time.Since(start).Milliseconds(),
		"matched": map[string]interface{}{
			"status":  statusMatch,
			"body":    bodyMatch,
			"headers": headerMatch,
		},
	}, nil
}

// isAllowedLocalTarget checks whether allowed local target.
func (e *Executor) isAllowedLocalTarget(target string) bool {
	normalized := strings.ToLower(strings.TrimSpace(target))
	if normalized == "" {
		return false
	}
	if normalized == "localhost" || normalized == "127.0.0.1" || normalized == "::1" {
		return true
	}

	facts, inventory, _ := e.state.Snapshot()
	allowed := map[string]struct{}{}
	for _, key := range []string{"hostname"} {
		if value, ok := facts[key].(string); ok && strings.TrimSpace(value) != "" {
			allowed[strings.ToLower(strings.TrimSpace(value))] = struct{}{}
		}
		if value, ok := inventory[key].(string); ok && strings.TrimSpace(value) != "" {
			allowed[strings.ToLower(strings.TrimSpace(value))] = struct{}{}
		}
	}

	if snapshotNetwork, ok := facts["snapshot"].(map[string]interface{}); ok {
		if network, ok := snapshotNetwork["network"].(map[string]interface{}); ok {
			if primary, ok := network["primaryIp"].(string); ok && strings.TrimSpace(primary) != "" {
				allowed[strings.ToLower(strings.TrimSpace(primary))] = struct{}{}
			}
			if interfaces, ok := network["interfaces"].([]interface{}); ok {
				for _, entry := range interfaces {
					record, ok := entry.(map[string]interface{})
					if !ok {
						continue
					}
					for _, key := range []string{"ipv4", "ip", "address"} {
						if value, ok := record[key].(string); ok && strings.TrimSpace(value) != "" {
							allowed[strings.ToLower(strings.TrimSpace(value))] = struct{}{}
						}
					}
				}
			}
		}
	}

	_, exists := allowed[normalized]
	return exists
}

// flattenHeaderMap implements flatten header map.
func flattenHeaderMap(headers http.Header) string {
	if len(headers) == 0 {
		return ""
	}
	builder := strings.Builder{}
	for key, values := range headers {
		builder.WriteString(key)
		builder.WriteString(":")
		builder.WriteString(strings.Join(values, ","))
		builder.WriteString("\n")
	}
	return builder.String()
}

// toolTerminalExec parses friendly shell-like commands and routes to strongly
// allowlisted tool handlers. Arbitrary command execution is intentionally blocked.
func (e *Executor) toolTerminalExec(ctx context.Context, args map[string]interface{}) (map[string]interface{}, error) {
	command := strings.TrimSpace(stringArg(args, "command", ""))
	if command == "" {
		return nil, errors.New("command is required")
	}
	if len(command) > 240 {
		return nil, errors.New("command too long")
	}

	parts := strings.Fields(command)
	if len(parts) == 0 {
		return nil, errors.New("command is required")
	}

	name := strings.ToLower(parts[0])

	switch name {
	case "help":
		return map[string]interface{}{
			"ok":      true,
			"command": command,
			"output": strings.Join([]string{
				"Allowed commands:",
				"  help",
				"  status",
				"  services",
				"  containers",
				"  df",
				"  ls [path]",
				"  ping <target> [count<=5]",
				"  traceroute <target> [maxHops<=30]",
				"  logs <service> [lines<=1000]",
			}, "\n"),
		}, nil
	case "status":
		return map[string]interface{}{
			"ok":      true,
			"command": command,
			"output":  marshalPretty(e.toolHostStatus()),
		}, nil
	case "services":
		return map[string]interface{}{
			"ok":      true,
			"command": command,
			"output":  marshalPretty(e.toolServicesList()),
		}, nil
	case "containers":
		return map[string]interface{}{
			"ok":      true,
			"command": command,
			"output":  marshalPretty(e.toolContainersList()),
		}, nil
	case "df":
		result, err := e.toolStorageDF(ctx)
		if err != nil {
			return nil, err
		}
		result["command"] = command
		return result, nil
	case "ls":
		path := "/home"
		if len(parts) >= 2 {
			path = parts[1]
		}
		result, err := e.toolListFiles(path)
		if err != nil {
			return nil, err
		}
		result["command"] = command
		return result, nil
	case "ping":
		if len(parts) < 2 {
			return nil, errors.New("usage: ping <target> [count]")
		}
		count := 3
		if len(parts) >= 3 {
			parsed, err := strconv.Atoi(parts[2])
			if err != nil {
				return nil, errors.New("ping count must be a number")
			}
			count = parsed
		}
		result, err := e.toolNetworkPing(ctx, map[string]interface{}{
			"target": parts[1],
			"count":  count,
		})
		if err != nil {
			return nil, err
		}
		result["command"] = command
		return result, nil
	case "traceroute":
		if len(parts) < 2 {
			return nil, errors.New("usage: traceroute <target> [maxHops]")
		}
		maxHops := 15
		if len(parts) >= 3 {
			parsed, err := strconv.Atoi(parts[2])
			if err != nil {
				return nil, errors.New("traceroute maxHops must be a number")
			}
			maxHops = parsed
		}
		result, err := e.toolNetworkTraceroute(ctx, map[string]interface{}{
			"target":  parts[1],
			"maxHops": maxHops,
		})
		if err != nil {
			return nil, err
		}
		result["command"] = command
		return result, nil
	case "logs":
		if len(parts) < 2 {
			return nil, errors.New("usage: logs <service> [lines]")
		}
		lines := 200
		if len(parts) >= 3 {
			parsed, err := strconv.Atoi(parts[2])
			if err != nil {
				return nil, errors.New("logs lines must be a number")
			}
			lines = parsed
		}
		result, err := e.toolLogsTail(ctx, map[string]interface{}{
			"source": "journalctl",
			"ref":    parts[1],
			"lines":  lines,
		})
		if err != nil {
			return nil, err
		}
		result["command"] = command
		return result, nil
	default:
		return nil, fmt.Errorf("command not allowed: %s", parts[0])
	}
}

// toolServicesList implements tool services list.
func (e *Executor) toolServicesList() map[string]interface{} {
	_, inventory, _ := e.state.Snapshot()
	services, _ := inventory["services"].([]interface{})
	return map[string]interface{}{"services": services}
}

// toolContainersList implements tool containers list.
func (e *Executor) toolContainersList() map[string]interface{} {
	_, inventory, _ := e.state.Snapshot()
	containers, _ := inventory["containers"].([]interface{})
	return map[string]interface{}{"containers": containers}
}

// toolListFiles implements tool list files.
func (e *Executor) toolListFiles(path string) (map[string]interface{}, error) {
	target, err := normalizeLsPath(path)
	if err != nil {
		return nil, err
	}

	entries, err := os.ReadDir(target)
	if err != nil {
		return nil, err
	}

	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() {
			name = name + "/"
		}
		names = append(names, name)
	}
	sort.Strings(names)
	truncated := false
	if len(names) > 200 {
		names = names[:200]
		truncated = true
	}

	return map[string]interface{}{
		"path":      target,
		"entries":   names,
		"count":     len(names),
		"truncated": truncated,
		"output":    strings.Join(names, "\n"),
		"ok":        true,
	}, nil
}

// toolLogsTail implements tool logs tail.
func (e *Executor) toolLogsTail(ctx context.Context, args map[string]interface{}) (map[string]interface{}, error) {
	source := stringArg(args, "source", "journalctl")
	ref := stringArg(args, "ref", "")
	lines := intArg(args, "lines", 200)
	sinceSec := intArg(args, "sinceSec", 600)
	if lines < 1 {
		lines = 1
	}
	if lines > 1000 {
		lines = 1000
	}
	if sinceSec < 0 {
		sinceSec = 0
	}

	var cmd *exec.Cmd
	switch source {
	case "journalctl":
		if ref == "" {
			return nil, errors.New("logs.tail requires ref for journalctl source")
		}
		cmd = exec.CommandContext(
			ctx,
			"journalctl",
			"-u", ref,
			"-n", strconv.Itoa(lines),
			"--since", fmt.Sprintf("-%ds", sinceSec),
			"--no-pager",
		)
	case "file":
		if !pathAllowedPattern.MatchString(ref) || strings.Contains(ref, "..") {
			return nil, errors.New("logs.tail file ref must be under /var/log or /tmp")
		}
		cmd = exec.CommandContext(ctx, "tail", "-n", strconv.Itoa(lines), ref)
	default:
		return nil, fmt.Errorf("unsupported logs source: %s", source)
	}

	stdout, stderr, err := runCommandCapture(cmd)
	output := stdout
	if stderr != "" {
		output += "\n" + stderr
	}
	redacted, wasRedacted := redact.RedactString(output)

	result := map[string]interface{}{
		"source":   source,
		"ref":      ref,
		"output":   redacted,
		"redacted": true,
		"changed":  wasRedacted,
	}
	if err != nil {
		result["error"] = err.Error()
	}
	return result, nil
}

// normalizeLsPath implements normalize ls path.
func normalizeLsPath(path string) (string, error) {
	trimmed := strings.TrimSpace(path)
	if trimmed == "" {
		return "/home", nil
	}
	if !strings.HasPrefix(trimmed, "/") {
		return "", errors.New("ls path must be absolute")
	}
	if strings.Contains(trimmed, "..") {
		return "", errors.New("ls path traversal is not allowed")
	}

	allowed := []string{"/home", "/root", "/tmp", "/var/log"}
	for _, prefix := range allowed {
		if trimmed == prefix || strings.HasPrefix(trimmed, prefix+"/") {
			return trimmed, nil
		}
	}

	return "", errors.New("ls path is not allowlisted")
}

// toolNetworkPing implements tool network ping.
func (e *Executor) toolNetworkPing(ctx context.Context, args map[string]interface{}) (map[string]interface{}, error) {
	target := stringArg(args, "target", "")
	if target == "" {
		return nil, errors.New("target is required")
	}
	count := intArg(args, "count", 3)
	if count < 1 {
		count = 1
	}
	if count > 5 {
		count = 5
	}
	cmd := exec.CommandContext(ctx, "ping", "-c", strconv.Itoa(count), target)
	stdout, stderr, err := runCommandCapture(cmd)
	output := strings.TrimSpace(stdout + "\n" + stderr)
	redacted, _ := redact.RedactString(output)
	return map[string]interface{}{
		"target": target,
		"count":  count,
		"output": redacted,
		"ok":     err == nil,
	}, nil
}

// toolNetworkTraceroute implements tool network traceroute.
func (e *Executor) toolNetworkTraceroute(ctx context.Context, args map[string]interface{}) (map[string]interface{}, error) {
	target := stringArg(args, "target", "")
	if target == "" {
		return nil, errors.New("target is required")
	}
	maxHops := intArg(args, "maxHops", 15)
	if maxHops < 1 {
		maxHops = 1
	}
	if maxHops > 30 {
		maxHops = 30
	}

	cmd := exec.CommandContext(ctx, "traceroute", "-m", strconv.Itoa(maxHops), target)
	stdout, stderr, err := runCommandCapture(cmd)
	if err != nil {
		return map[string]interface{}{
			"target": target,
			"output": strings.TrimSpace(stdout + "\n" + stderr),
			"ok":     false,
		}, nil
	}

	redacted, _ := redact.RedactString(strings.TrimSpace(stdout + "\n" + stderr))
	return map[string]interface{}{
		"target": target,
		"output": redacted,
		"ok":     true,
	}, nil
}

type subnetScanProbe struct {
	Protocol       string
	Port           int
	Path           string
	StatusCodes    []int
	BodyContains   []string
	HeadersContain []string
}

type subnetScanSignature struct {
	ID     string
	Name   string
	Tags   []string
	Probes []subnetScanProbe
}

type subnetScanTarget struct {
	ServiceID   string
	ServiceName string
	Source      string
	Tags        []string
	Probe       subnetScanProbe
}

// toolNetworkScanKnownServices implements tool network scan known services.
func (e *Executor) toolNetworkScanKnownServices(ctx context.Context, args map[string]interface{}) (map[string]interface{}, error) {
	return e.toolNetworkScanKnownServicesWithProgress(ctx, args, nil)
}

// toolNetworkScanKnownServicesStart implements tool network scan known services start.
func (e *Executor) toolNetworkScanKnownServicesStart(args map[string]interface{}) (map[string]interface{}, error) {
	now := time.Now().UTC()
	timeout := subnetScanToolTimeoutFromArgs(args)
	job := &subnetScanJob{
		ID:        fmt.Sprintf("subnet-scan-%d", now.UnixNano()),
		State:     subnetScanJobStateRunning,
		StartedAt: now,
		UpdatedAt: now,
		Progress: subnetScanJobProgress{
			CIDRs: normalizeCIDRList(stringSliceArg(args, "cidrs", 128, 64)),
		},
	}

	e.subnetScanMu.Lock()
	defer e.subnetScanMu.Unlock()
	e.cleanupExpiredSubnetScanJobsLocked(now)
	if e.activeSubnetID != "" {
		if active, ok := e.subnetScanJobs[e.activeSubnetID]; ok && active.State == subnetScanJobStateRunning {
			return nil, errors.New("subnet scan already running")
		}
		e.activeSubnetID = ""
	}
	e.subnetScanJobs[job.ID] = job
	e.activeSubnetID = job.ID

	argsCopy := deepCopyMap(args)
	go e.runSubnetScanJob(job.ID, argsCopy, timeout)

	return map[string]interface{}{
		"ok":        true,
		"jobId":     job.ID,
		"state":     string(job.State),
		"startedAt": job.StartedAt.Format(time.RFC3339),
		"updatedAt": job.UpdatedAt.Format(time.RFC3339),
		"timeoutMs": timeout.Milliseconds(),
	}, nil
}

// toolNetworkScanKnownServicesStatus implements tool network scan known services status.
func (e *Executor) toolNetworkScanKnownServicesStatus(args map[string]interface{}) (map[string]interface{}, error) {
	jobID := strings.TrimSpace(stringArg(args, "jobId", ""))
	if jobID == "" {
		return nil, errors.New("jobId is required")
	}

	e.subnetScanMu.Lock()
	defer e.subnetScanMu.Unlock()
	e.cleanupExpiredSubnetScanJobsLocked(time.Now().UTC())
	job, ok := e.subnetScanJobs[jobID]
	if !ok {
		return nil, errors.New("subnet scan job not found")
	}
	return e.snapshotSubnetScanJobLocked(job), nil
}

// toolNetworkScanKnownServicesResult implements tool network scan known services result.
func (e *Executor) toolNetworkScanKnownServicesResult(args map[string]interface{}) (map[string]interface{}, error) {
	jobID := strings.TrimSpace(stringArg(args, "jobId", ""))
	if jobID == "" {
		return nil, errors.New("jobId is required")
	}

	e.subnetScanMu.Lock()
	defer e.subnetScanMu.Unlock()
	e.cleanupExpiredSubnetScanJobsLocked(time.Now().UTC())
	job, ok := e.subnetScanJobs[jobID]
	if !ok {
		return nil, errors.New("subnet scan job not found")
	}
	switch job.State {
	case subnetScanJobStateRunning:
		return nil, errors.New("subnet scan job is still running")
	case subnetScanJobStateFailed:
		return nil, fmt.Errorf("subnet scan job failed: %s", job.Error)
	}

	response := e.snapshotSubnetScanJobLocked(job)
	response["result"] = deepCopyMap(job.Result)
	delete(e.subnetScanJobs, jobID)
	if e.activeSubnetID == jobID {
		e.activeSubnetID = ""
	}
	return response, nil
}

// toolNetworkScanKnownServicesWithProgress implements tool network scan known services with progress.
func (e *Executor) toolNetworkScanKnownServicesWithProgress(
	ctx context.Context,
	args map[string]interface{},
	onProgress func(subnetScanJobProgress),
) (map[string]interface{}, error) {
	maxHosts := intArg(args, "maxHosts", 512)
	if maxHosts < 1 {
		maxHosts = 1
	}
	if maxHosts > 4096 {
		maxHosts = 4096
	}
	concurrency := intArg(args, "concurrency", 24)
	if concurrency < 1 {
		concurrency = 1
	}
	if concurrency > 128 {
		concurrency = 128
	}
	connectTimeoutMs := intArg(args, "connectTimeoutMs", 750)
	if connectTimeoutMs < 100 {
		connectTimeoutMs = 100
	}
	if connectTimeoutMs > 10_000 {
		connectTimeoutMs = 10_000
	}
	includeAutoLocalCidrs := boolArg(args, "includeAutoLocalCidrs", false)
	includeCommonWebPorts := boolArg(args, "includeCommonWebPorts", true)

	cidrs := normalizeCIDRList(stringSliceArg(args, "cidrs", 128, 64))
	warnings := make([]string, 0, 4)
	if includeAutoLocalCidrs {
		autoCidrs, err := discoverLocalPrivateCIDRs()
		if err != nil {
			warnings = append(warnings, "failed to enumerate local interfaces for CIDR detection")
		} else {
			cidrs = normalizeCIDRList(append(cidrs, autoCidrs...))
		}
	}

	if len(cidrs) == 0 {
		result := map[string]interface{}{
			"ok":             true,
			"cidrs":          []string{},
			"hostsScanned":   0,
			"hostsReachable": 0,
			"detections":     []map[string]interface{}{},
			"warnings":       append(warnings, "no CIDRs provided"),
		}
		if onProgress != nil {
			onProgress(subnetScanJobProgress{
				CIDRs:        []string{},
				HostsPlanned: 0,
				Warnings:     copyStringSlice(result["warnings"].([]string)),
			})
		}
		return result, nil
	}

	signatures := parseSubnetScanSignatures(args["signatures"])
	targets := buildSubnetScanTargets(signatures, includeCommonWebPorts)
	if len(targets) == 0 {
		result := map[string]interface{}{
			"ok":             true,
			"cidrs":          cidrs,
			"hostsScanned":   0,
			"hostsReachable": 0,
			"detections":     []map[string]interface{}{},
			"warnings":       append(warnings, "no scan probes configured"),
		}
		if onProgress != nil {
			onProgress(subnetScanJobProgress{
				CIDRs:        copyStringSlice(cidrs),
				HostsPlanned: 0,
				Warnings:     copyStringSlice(result["warnings"].([]string)),
			})
		}
		return result, nil
	}

	hosts, truncated := enumerateCIDRHosts(cidrs, maxHosts)
	if truncated {
		warnings = append(warnings, "host list truncated by maxHosts limit")
	}
	totalHosts := len(hosts)
	remainingHosts := len(hosts)

	if len(hosts) == 0 {
		result := map[string]interface{}{
			"ok":             true,
			"cidrs":          cidrs,
			"hostsScanned":   0,
			"hostsReachable": 0,
			"detections":     []map[string]interface{}{},
			"warnings":       append(warnings, "no host addresses available in CIDRs"),
		}
		if onProgress != nil {
			onProgress(subnetScanJobProgress{
				CIDRs:        copyStringSlice(cidrs),
				HostsPlanned: 0,
				Warnings:     copyStringSlice(result["warnings"].([]string)),
			})
		}
		return result, nil
	}

	if concurrency > len(hosts) {
		concurrency = len(hosts)
	}
	if onProgress != nil {
		onProgress(subnetScanJobProgress{
			CIDRs:        copyStringSlice(cidrs),
			HostsPlanned: totalHosts,
			Warnings:     copyStringSlice(warnings),
		})
	}

	type hostScanResult struct {
		ip        string
		reachable bool
		findings  []map[string]interface{}
	}

	hostQueue := make(chan string)
	results := make(chan hostScanResult, len(hosts))
	var workerWG sync.WaitGroup
	for i := 0; i < concurrency; i++ {
		workerWG.Add(1)
		go func() {
			defer workerWG.Done()
			for ip := range hostQueue {
				reachable, findings := scanHostTargets(ctx, ip, targets, connectTimeoutMs)
				results <- hostScanResult{
					ip:        ip,
					reachable: reachable,
					findings:  findings,
				}
			}
		}()
	}

enqueueHosts:
	for _, ip := range hosts {
		select {
		case <-ctx.Done():
			break enqueueHosts
		case hostQueue <- ip:
			remainingHosts--
		}
	}
	close(hostQueue)
	workerWG.Wait()
	close(results)

	detectionSeen := make(map[string]struct{})
	detections := make([]map[string]interface{}, 0, 128)
	hostsScanned := 0
	hostsReachable := 0
	probedIps := make([]string, 0, len(hosts))
	reachableIps := make([]string, 0, len(hosts))
	for result := range results {
		hostsScanned++
		probedIps = append(probedIps, result.ip)
		if result.reachable {
			hostsReachable++
			reachableIps = append(reachableIps, result.ip)
		}
		for _, finding := range result.findings {
			serviceID, _ := finding["serviceId"].(string)
			endpoint, _ := finding["endpoint"].(string)
			key := strings.ToLower(result.ip + "|" + serviceID + "|" + endpoint)
			if _, exists := detectionSeen[key]; exists {
				continue
			}
			detectionSeen[key] = struct{}{}
			detections = append(detections, finding)
		}
		if onProgress != nil {
			onProgress(subnetScanJobProgress{
				CIDRs:          copyStringSlice(cidrs),
				HostsPlanned:   totalHosts,
				HostsScanned:   hostsScanned,
				HostsReachable: hostsReachable,
				Detections:     len(detections),
				Warnings:       copyStringSlice(warnings),
			})
		}
	}
	sort.Strings(probedIps)
	sort.Strings(reachableIps)
	if hostsScanned > 0 && hostsReachable == 0 {
		warnings = append(warnings, "no hosts were reachable in requested CIDRs; verify routing or firewall access from this agent host")
	}
	if remainingHosts > 0 {
		reason := "subnet scan stopped before all hosts were probed"
		if err := ctx.Err(); err != nil {
			reason = fmt.Sprintf("subnet scan interrupted: %s", err.Error())
		}
		warnings = append(
			warnings,
			fmt.Sprintf("%s (scanned %d of %d host(s)); increase toolCallTimeoutMs or reduce maxHosts", reason, hostsScanned, hostsScanned+remainingHosts),
		)
	}

	result := map[string]interface{}{
		"ok":             true,
		"cidrs":          cidrs,
		"hostsScanned":   hostsScanned,
		"hostsReachable": hostsReachable,
		"probedIps":      probedIps,
		"reachableIps":   reachableIps,
		"detections":     detections,
		"warnings":       warnings,
	}
	if onProgress != nil {
		onProgress(subnetScanJobProgress{
			CIDRs:          copyStringSlice(cidrs),
			HostsPlanned:   totalHosts,
			HostsScanned:   hostsScanned,
			HostsReachable: hostsReachable,
			Detections:     len(detections),
			Warnings:       copyStringSlice(warnings),
		})
	}
	return result, nil
}

// subnetScanToolTimeoutFromArgs implements subnet scan tool timeout from args.
func subnetScanToolTimeoutFromArgs(args map[string]interface{}) time.Duration {
	parsedMs := intArg(args, "toolCallTimeoutMs", subnetScanToolTimeoutDefault)
	if parsedMs < subnetScanToolTimeoutMin {
		parsedMs = subnetScanToolTimeoutMin
	}
	if parsedMs > subnetScanToolTimeoutMax {
		parsedMs = subnetScanToolTimeoutMax
	}
	return time.Duration(parsedMs) * time.Millisecond
}

// runSubnetScanJob implements run subnet scan job.
func (e *Executor) runSubnetScanJob(jobID string, args map[string]interface{}, timeout time.Duration) {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	defer func() {
		if recovered := recover(); recovered != nil {
			e.finishSubnetScanJobFailed(jobID, fmt.Sprintf("panic: %v", recovered))
		}
	}()

	result, err := e.toolNetworkScanKnownServicesWithProgress(ctx, args, func(progress subnetScanJobProgress) {
		e.updateSubnetScanJobProgress(jobID, progress)
	})
	if err != nil {
		e.finishSubnetScanJobFailed(jobID, err.Error())
		return
	}
	e.finishSubnetScanJobCompleted(jobID, result)
}

// updateSubnetScanJobProgress implements update subnet scan job progress.
func (e *Executor) updateSubnetScanJobProgress(jobID string, progress subnetScanJobProgress) {
	e.subnetScanMu.Lock()
	defer e.subnetScanMu.Unlock()
	job, ok := e.subnetScanJobs[jobID]
	if !ok {
		return
	}
	job.Progress = progress.clone()
	job.UpdatedAt = time.Now().UTC()
}

// finishSubnetScanJobCompleted implements finish subnet scan job completed.
func (e *Executor) finishSubnetScanJobCompleted(jobID string, result map[string]interface{}) {
	now := time.Now().UTC()
	e.subnetScanMu.Lock()
	defer e.subnetScanMu.Unlock()
	job, ok := e.subnetScanJobs[jobID]
	if !ok {
		return
	}
	job.State = subnetScanJobStateCompleted
	job.UpdatedAt = now
	job.FinishedAt = &now
	job.ExpiresAt = now.Add(subnetScanJobRetention)
	job.Result = deepCopyMap(result)
	job.Error = ""
	progress := job.Progress.clone()
	progress.CIDRs = copyInterfaceStrings(result["cidrs"])
	progress.HostsScanned = intArg(result, "hostsScanned", 0)
	progress.HostsReachable = intArg(result, "hostsReachable", 0)
	progress.Detections = detectionCountFromValue(result["detections"])
	progress.Warnings = copyInterfaceStrings(result["warnings"])
	if progress.HostsPlanned < progress.HostsScanned {
		progress.HostsPlanned = progress.HostsScanned
	}
	job.Progress = progress
	if e.activeSubnetID == jobID {
		e.activeSubnetID = ""
	}
}

// finishSubnetScanJobFailed implements finish subnet scan job failed.
func (e *Executor) finishSubnetScanJobFailed(jobID string, message string) {
	now := time.Now().UTC()
	e.subnetScanMu.Lock()
	defer e.subnetScanMu.Unlock()
	job, ok := e.subnetScanJobs[jobID]
	if !ok {
		return
	}
	job.State = subnetScanJobStateFailed
	job.UpdatedAt = now
	job.FinishedAt = &now
	job.ExpiresAt = now.Add(subnetScanJobRetention)
	job.Error = strings.TrimSpace(message)
	if e.activeSubnetID == jobID {
		e.activeSubnetID = ""
	}
}

// cleanupExpiredSubnetScanJobsLocked implements cleanup expired subnet scan jobs locked.
func (e *Executor) cleanupExpiredSubnetScanJobsLocked(now time.Time) {
	for id, job := range e.subnetScanJobs {
		if job.State == subnetScanJobStateRunning {
			continue
		}
		if job.ExpiresAt.IsZero() || !job.ExpiresAt.Before(now) && !job.ExpiresAt.Equal(now) {
			continue
		}
		delete(e.subnetScanJobs, id)
		if e.activeSubnetID == id {
			e.activeSubnetID = ""
		}
	}
}

// snapshotSubnetScanJobLocked implements snapshot subnet scan job locked.
func (e *Executor) snapshotSubnetScanJobLocked(job *subnetScanJob) map[string]interface{} {
	response := map[string]interface{}{
		"ok":             job.State != subnetScanJobStateFailed,
		"jobId":          job.ID,
		"state":          string(job.State),
		"startedAt":      job.StartedAt.Format(time.RFC3339),
		"updatedAt":      job.UpdatedAt.Format(time.RFC3339),
		"hostsScanned":   job.Progress.HostsScanned,
		"hostsReachable": job.Progress.HostsReachable,
		"detections":     job.Progress.Detections,
		"warnings":       copyStringSlice(job.Progress.Warnings),
		"progress": map[string]interface{}{
			"cidrs":          copyStringSlice(job.Progress.CIDRs),
			"hostsPlanned":   job.Progress.HostsPlanned,
			"hostsScanned":   job.Progress.HostsScanned,
			"hostsReachable": job.Progress.HostsReachable,
			"detections":     job.Progress.Detections,
			"warnings":       copyStringSlice(job.Progress.Warnings),
		},
	}
	if job.FinishedAt != nil {
		response["finishedAt"] = job.FinishedAt.Format(time.RFC3339)
	}
	if job.Error != "" {
		response["error"] = job.Error
	}
	return response
}

// copyInterfaceStrings implements copy interface strings.
func copyInterfaceStrings(value interface{}) []string {
	switch typed := value.(type) {
	case []string:
		return copyStringSlice(typed)
	case []interface{}:
		items := make([]string, 0, len(typed))
		for _, entry := range typed {
			text, ok := entry.(string)
			if !ok {
				continue
			}
			items = append(items, text)
		}
		return items
	default:
		return []string{}
	}
}

// detectionCountFromValue implements detection count from value.
func detectionCountFromValue(value interface{}) int {
	switch typed := value.(type) {
	case []map[string]interface{}:
		return len(typed)
	case []interface{}:
		return len(typed)
	default:
		return 0
	}
}

// parseSubnetScanSignatures parses subnet scan signatures.
func parseSubnetScanSignatures(raw interface{}) []subnetScanSignature {
	items, ok := raw.([]interface{})
	if !ok {
		return []subnetScanSignature{}
	}

	signatures := make([]subnetScanSignature, 0, len(items))
	for _, item := range items {
		record, ok := item.(map[string]interface{})
		if !ok {
			continue
		}
		id := strings.TrimSpace(stringArg(record, "id", ""))
		name := strings.TrimSpace(stringArg(record, "name", ""))
		if id == "" || name == "" {
			continue
		}
		tags := stringSliceArg(record, "tags", 12, 40)

		rawProbes, _ := record["probes"].([]interface{})
		probes := make([]subnetScanProbe, 0, len(rawProbes))
		for _, probeRaw := range rawProbes {
			probeRecord, ok := probeRaw.(map[string]interface{})
			if !ok {
				continue
			}
			protocol := strings.ToLower(strings.TrimSpace(stringArg(probeRecord, "protocol", "")))
			if protocol != "http" && protocol != "https" && protocol != "tcp" {
				continue
			}
			ports := intSliceArg(probeRecord, "ports", 20)
			statusCodes := intSliceArg(probeRecord, "statusCodes", 12)
			bodyContains := stringSliceArg(probeRecord, "bodyContains", 12, 120)
			headersContain := stringSliceArg(probeRecord, "headersContain", 12, 120)
			path := strings.TrimSpace(stringArg(probeRecord, "path", "/"))
			if path == "" {
				path = "/"
			}
			if !strings.HasPrefix(path, "/") {
				path = "/" + path
			}
			for _, port := range ports {
				if port < 1 || port > 65535 {
					continue
				}
				probes = append(probes, subnetScanProbe{
					Protocol:       protocol,
					Port:           port,
					Path:           path,
					StatusCodes:    statusCodes,
					BodyContains:   bodyContains,
					HeadersContain: headersContain,
				})
			}
		}

		if len(probes) == 0 {
			continue
		}
		signatures = append(signatures, subnetScanSignature{
			ID:     id,
			Name:   name,
			Tags:   tags,
			Probes: probes,
		})
	}

	return signatures
}

// buildSubnetScanTargets builds subnet scan targets.
func buildSubnetScanTargets(signatures []subnetScanSignature, includeCommonWebPorts bool) []subnetScanTarget {
	targets := make([]subnetScanTarget, 0, len(signatures)*4)
	for _, signature := range signatures {
		for _, probe := range signature.Probes {
			targets = append(targets, subnetScanTarget{
				ServiceID:   signature.ID,
				ServiceName: signature.Name,
				Source:      "signature",
				Tags:        signature.Tags,
				Probe:       probe,
			})
		}
	}
	if includeCommonWebPorts {
		commonWebPorts := []int{80, 443, 8080, 8443}
		for _, port := range commonWebPorts {
			targets = append(targets, subnetScanTarget{
				ServiceID:   fmt.Sprintf("unknown-web-%d", port),
				ServiceName: "Web Service",
				Source:      "common-web",
				Tags:        []string{"web"},
				Probe: subnetScanProbe{
					Protocol: "tcp",
					Port:     port,
					Path:     "/",
				},
			})
		}
	}
	return targets
}

// scanHostTargets implements scan host targets.
func scanHostTargets(
	ctx context.Context,
	ip string,
	targets []subnetScanTarget,
	connectTimeoutMs int,
) (bool, []map[string]interface{}) {
	reachable := false
	findings := make([]map[string]interface{}, 0, 8)
	seenService := make(map[string]struct{})

	for _, target := range targets {
		probeResult := executeSubnetProbe(ctx, ip, target.Probe, connectTimeoutMs)
		if probeResult.reachable {
			reachable = true
		}
		if !probeResult.matched {
			continue
		}

		endpoint := probeResult.endpoint
		if target.Source == "common-web" {
			scheme := "http"
			if target.Probe.Port == 443 || target.Probe.Port == 8443 {
				scheme = "https"
			}
			endpoint = fmt.Sprintf("%s://%s:%d", scheme, ip, target.Probe.Port)
		}

		key := strings.ToLower(target.ServiceID + "|" + endpoint)
		if _, exists := seenService[key]; exists {
			continue
		}
		seenService[key] = struct{}{}

		findings = append(findings, map[string]interface{}{
			"ip":          ip,
			"hostname":    "",
			"serviceId":   target.ServiceID,
			"serviceName": target.ServiceName,
			"endpoint":    endpoint,
			"confidence": func() float64 {
				if target.Source == "common-web" {
					return 0.45
				}
				return 0.82
			}(),
			"source": target.Source,
			"tags":   target.Tags,
			"evidence": map[string]interface{}{
				"protocol":   target.Probe.Protocol,
				"port":       target.Probe.Port,
				"statusCode": probeResult.statusCode,
				"latencyMs":  probeResult.latencyMs,
			},
		})
	}

	return reachable, findings
}

type subnetProbeExecution struct {
	matched    bool
	reachable  bool
	endpoint   string
	statusCode int
	latencyMs  int64
}

// executeSubnetProbe implements execute subnet probe.
func executeSubnetProbe(
	ctx context.Context,
	targetIP string,
	probe subnetScanProbe,
	connectTimeoutMs int,
) subnetProbeExecution {
	dialTimeout := time.Duration(connectTimeoutMs) * time.Millisecond
	address := net.JoinHostPort(targetIP, strconv.Itoa(probe.Port))

	if probe.Protocol == "tcp" {
		start := time.Now()
		conn, err := net.DialTimeout("tcp", address, dialTimeout)
		if err != nil {
			return subnetProbeExecution{matched: false, reachable: false}
		}
		_ = conn.Close()
		return subnetProbeExecution{
			matched:   true,
			reachable: true,
			endpoint:  fmt.Sprintf("tcp://%s", address),
			latencyMs: time.Since(start).Milliseconds(),
		}
	}

	if probe.Path == "" {
		probe.Path = "/"
	}
	if !strings.HasPrefix(probe.Path, "/") {
		probe.Path = "/" + probe.Path
	}
	urlValue := fmt.Sprintf("%s://%s:%d%s", probe.Protocol, targetIP, probe.Port, probe.Path)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, urlValue, nil)
	if err != nil {
		return subnetProbeExecution{matched: false, reachable: false}
	}
	client := &http.Client{
		Timeout: dialTimeout,
	}

	start := time.Now()
	response, err := client.Do(request)
	if err != nil {
		return subnetProbeExecution{matched: false, reachable: false}
	}
	defer response.Body.Close()

	bodyBytes, _ := io.ReadAll(io.LimitReader(response.Body, 48*1024))
	bodyText := strings.ToLower(string(bodyBytes))
	headerText := strings.ToLower(flattenHeaderMap(response.Header))
	statusMatch := len(probe.StatusCodes) == 0
	if len(probe.StatusCodes) > 0 {
		for _, expected := range probe.StatusCodes {
			if response.StatusCode == expected {
				statusMatch = true
				break
			}
		}
	}
	bodyMatch := len(probe.BodyContains) == 0
	if len(probe.BodyContains) > 0 {
		bodyMatch = true
		for _, needle := range probe.BodyContains {
			if !strings.Contains(bodyText, strings.ToLower(needle)) {
				bodyMatch = false
				break
			}
		}
	}
	headersMatch := len(probe.HeadersContain) == 0
	if len(probe.HeadersContain) > 0 {
		headersMatch = true
		for _, needle := range probe.HeadersContain {
			if !strings.Contains(headerText, strings.ToLower(needle)) {
				headersMatch = false
				break
			}
		}
	}

	return subnetProbeExecution{
		matched:    statusMatch && bodyMatch && headersMatch,
		reachable:  true,
		endpoint:   urlValue,
		statusCode: response.StatusCode,
		latencyMs:  time.Since(start).Milliseconds(),
	}
}

// normalizeCIDRList implements normalize cidrlist.
func normalizeCIDRList(values []string) []string {
	seen := make(map[string]struct{})
	normalized := make([]string, 0, len(values))
	for _, value := range values {
		trimmed := strings.TrimSpace(strings.ToLower(value))
		if trimmed == "" {
			continue
		}
		if _, _, err := net.ParseCIDR(trimmed); err != nil {
			continue
		}
		if _, exists := seen[trimmed]; exists {
			continue
		}
		seen[trimmed] = struct{}{}
		normalized = append(normalized, trimmed)
		if len(normalized) >= 128 {
			break
		}
	}
	return normalized
}

// discoverLocalPrivateCIDRs implements discover local private cidrs.
func discoverLocalPrivateCIDRs() ([]string, error) {
	interfaces, err := net.Interfaces()
	if err != nil {
		return nil, err
	}
	collected := make([]string, 0, 8)
	for _, iface := range interfaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addresses, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, address := range addresses {
			ipNet, ok := address.(*net.IPNet)
			if !ok {
				continue
			}
			ip := ipNet.IP.To4()
			if ip == nil || !isPrivateIPv4(ip) {
				continue
			}
			ones, _ := ipNet.Mask.Size()
			if ones < 16 {
				ones = 16
			}
			if ones > 30 {
				ones = 30
			}
			collected = append(collected, fmt.Sprintf("%s/%d", ip.Mask(ipNet.Mask).String(), ones))
		}
	}
	return normalizeCIDRList(collected), nil
}

// isPrivateIPv4 checks whether private ipv4.
func isPrivateIPv4(ip net.IP) bool {
	if ip == nil {
		return false
	}
	if ip[0] == 10 {
		return true
	}
	if ip[0] == 172 && ip[1] >= 16 && ip[1] <= 31 {
		return true
	}
	if ip[0] == 192 && ip[1] == 168 {
		return true
	}
	return false
}

// enumerateCIDRHosts implements enumerate cidrhosts.
func enumerateCIDRHosts(cidrs []string, maxHosts int) ([]string, bool) {
	hosts := make([]string, 0, maxHosts)
	truncated := false

	for _, cidr := range cidrs {
		if len(hosts) >= maxHosts {
			truncated = true
			break
		}

		_, ipNet, err := net.ParseCIDR(cidr)
		if err != nil {
			continue
		}
		base := ipNet.IP.To4()
		if base == nil {
			continue
		}

		ones, bits := ipNet.Mask.Size()
		if bits != 32 {
			continue
		}
		if ones >= 31 {
			ipText := base.String()
			if ipText != "" {
				hosts = append(hosts, ipText)
			}
			continue
		}

		network := ipv4ToUint32(base)
		hostBits := uint32(32 - ones)
		broadcast := network | ((1 << hostBits) - 1)
		for candidate := network + 1; candidate < broadcast; candidate++ {
			hosts = append(hosts, uint32ToIPv4(candidate).String())
			if len(hosts) >= maxHosts {
				truncated = true
				break
			}
		}
		if truncated {
			break
		}
	}

	return hosts, truncated
}

// ipv4ToUint32 implements ipv4 to uint32.
func ipv4ToUint32(ip net.IP) uint32 {
	value := ip.To4()
	if value == nil {
		return 0
	}
	return uint32(value[0])<<24 | uint32(value[1])<<16 | uint32(value[2])<<8 | uint32(value[3])
}

// uint32ToIPv4 implements uint32 to ipv4.
func uint32ToIPv4(value uint32) net.IP {
	return net.IPv4(
		byte(value>>24),
		byte(value>>16),
		byte(value>>8),
		byte(value),
	)
}

// toolStorageDF implements tool storage df.
func (e *Executor) toolStorageDF(ctx context.Context) (map[string]interface{}, error) {
	cmd := exec.CommandContext(ctx, "df", "-h")
	stdout, stderr, err := runCommandCapture(cmd)
	output := strings.TrimSpace(stdout + "\n" + stderr)
	redacted, _ := redact.RedactString(output)
	return map[string]interface{}{
		"output": redacted,
		"ok":     err == nil,
	}, nil
}

// toolServiceRestart implements tool service restart.
func (e *Executor) toolServiceRestart(ctx context.Context, args map[string]interface{}) (map[string]interface{}, error) {
	name := stringArg(args, "name", "")
	if !serviceNamePattern.MatchString(name) {
		return nil, errors.New("invalid service name")
	}

	cmd := exec.CommandContext(ctx, "systemctl", "restart", name)
	_, stderr, err := runCommandCapture(cmd)
	if err != nil {
		redacted, _ := redact.RedactString(stderr)
		return map[string]interface{}{"ok": false, "error": redacted}, nil
	}
	return map[string]interface{}{"ok": true, "service": name}, nil
}

// toolContainerRestart implements tool container restart.
func (e *Executor) toolContainerRestart(ctx context.Context, args map[string]interface{}) (map[string]interface{}, error) {
	id := stringArg(args, "id", "")
	if !containerIDPattern.MatchString(id) {
		return nil, errors.New("invalid container id")
	}
	cmd := exec.CommandContext(ctx, "docker", "restart", id)
	stdout, stderr, err := runCommandCapture(cmd)
	if err != nil {
		redacted, _ := redact.RedactString(strings.TrimSpace(stdout + "\n" + stderr))
		return map[string]interface{}{"ok": false, "error": redacted}, nil
	}
	return map[string]interface{}{"ok": true, "container": id}, nil
}

// toolComposeRedeploy implements tool compose redeploy.
func (e *Executor) toolComposeRedeploy(ctx context.Context, args map[string]interface{}) (map[string]interface{}, error) {
	project := stringArg(args, "project", "")
	if !composeProjectPattern.MatchString(project) {
		return nil, errors.New("invalid compose project")
	}
	cmd := exec.CommandContext(ctx, "docker", "compose", "-p", project, "up", "-d")
	stdout, stderr, err := runCommandCapture(cmd)
	output := strings.TrimSpace(stdout + "\n" + stderr)
	redacted, _ := redact.RedactString(output)
	return map[string]interface{}{
		"ok":      err == nil,
		"project": project,
		"output":  redacted,
	}, nil
}

// toolHostReboot implements tool host reboot.
func (e *Executor) toolHostReboot(ctx context.Context, args map[string]interface{}) (map[string]interface{}, error) {
	confirm, _ := args["confirm"].(bool)
	if !confirm {
		return nil, errors.New("host.reboot requires confirm=true")
	}
	cmd := exec.CommandContext(ctx, "shutdown", "-r", "+1", "Reboot initiated by homelab control plane")
	_, stderr, err := runCommandCapture(cmd)
	if err != nil {
		redacted, _ := redact.RedactString(stderr)
		return map[string]interface{}{"ok": false, "error": redacted}, nil
	}
	return map[string]interface{}{"ok": true, "scheduledInMinutes": 1}, nil
}

// runCommandCapture implements run command capture.
func runCommandCapture(cmd *exec.Cmd) (string, string, error) {
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	return strings.TrimSpace(stdout.String()), strings.TrimSpace(stderr.String()), err
}

// marshalPretty implements marshal pretty.
func marshalPretty(value interface{}) string {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return fmt.Sprintf("%v", value)
	}
	return string(data)
}

// stringArg implements string arg.
func stringArg(args map[string]interface{}, key, fallback string) string {
	value, ok := args[key]
	if !ok {
		return fallback
	}
	if text, ok := value.(string); ok {
		return strings.TrimSpace(text)
	}
	return fallback
}

// intArg implements int arg.
func intArg(args map[string]interface{}, key string, fallback int) int {
	value, ok := args[key]
	if !ok {
		return fallback
	}
	switch typed := value.(type) {
	case float64:
		return int(typed)
	case int:
		return typed
	case int64:
		return int(typed)
	case string:
		parsed, err := strconv.Atoi(typed)
		if err == nil {
			return parsed
		}
	}
	return fallback
}

// boolArg implements bool arg.
func boolArg(args map[string]interface{}, key string, fallback bool) bool {
	value, ok := args[key]
	if !ok {
		return fallback
	}
	switch typed := value.(type) {
	case bool:
		return typed
	case string:
		normalized := strings.ToLower(strings.TrimSpace(typed))
		if normalized == "true" || normalized == "1" || normalized == "yes" || normalized == "on" {
			return true
		}
		if normalized == "false" || normalized == "0" || normalized == "no" || normalized == "off" {
			return false
		}
	}
	return fallback
}

// intPtrArg implements int ptr arg.
func intPtrArg(args map[string]interface{}, key string) (int, bool) {
	value, ok := args[key]
	if !ok {
		return 0, false
	}
	switch typed := value.(type) {
	case float64:
		return int(typed), true
	case int:
		return typed, true
	case int64:
		return int(typed), true
	case string:
		parsed, err := strconv.Atoi(strings.TrimSpace(typed))
		if err == nil {
			return parsed, true
		}
	}
	return 0, false
}

// intSliceArg implements int slice arg.
func intSliceArg(args map[string]interface{}, key string, maxLen int) []int {
	value, ok := nestedArg(args, key)
	if !ok {
		return []int{}
	}
	items, ok := value.([]interface{})
	if !ok {
		return []int{}
	}
	results := make([]int, 0, len(items))
	for _, item := range items {
		switch typed := item.(type) {
		case float64:
			results = append(results, int(typed))
		case int:
			results = append(results, typed)
		case string:
			parsed, err := strconv.Atoi(typed)
			if err == nil {
				results = append(results, parsed)
			}
		}
		if len(results) >= maxLen {
			break
		}
	}
	return results
}

// stringSliceArg implements string slice arg.
func stringSliceArg(args map[string]interface{}, key string, maxLen int, maxItemLen int) []string {
	value, ok := nestedArg(args, key)
	if !ok {
		return []string{}
	}
	items, ok := value.([]interface{})
	if !ok {
		return []string{}
	}
	results := make([]string, 0, len(items))
	for _, item := range items {
		text, ok := item.(string)
		if !ok {
			continue
		}
		trimmed := strings.TrimSpace(text)
		if trimmed == "" {
			continue
		}
		if len(trimmed) > maxItemLen {
			trimmed = trimmed[:maxItemLen]
		}
		results = append(results, trimmed)
		if len(results) >= maxLen {
			break
		}
	}
	return results
}

// nestedArg implements nested arg.
func nestedArg(args map[string]interface{}, path string) (interface{}, bool) {
	if path == "" {
		return nil, false
	}
	parts := strings.Split(path, ".")
	var current interface{} = args
	for _, part := range parts {
		record, ok := current.(map[string]interface{})
		if !ok {
			return nil, false
		}
		value, exists := record[part]
		if !exists {
			return nil, false
		}
		current = value
	}
	return current, true
}

// SortByTopProcesses implements sort by top processes.
func SortByTopProcesses(lines []string, limit int) []string {
	sorted := make([]string, 0, len(lines))
	sorted = append(sorted, lines...)
	sort.Strings(sorted)
	if len(sorted) > limit {
		return sorted[:limit]
	}
	return sorted
}

// SafeReadFile enforces path allowlists and optional tailing for diagnostics.
func SafeReadFile(path string, lines int) (string, error) {
	if !pathAllowedPattern.MatchString(path) || strings.Contains(path, "..") {
		return "", errors.New("path not allowed")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	parts := strings.Split(string(data), "\n")
	if lines > 0 && len(parts) > lines {
		parts = parts[len(parts)-lines:]
	}
	return strings.Join(parts, "\n"), nil
}
