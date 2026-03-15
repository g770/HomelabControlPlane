// Copyright (c) 2026 Homelab Control Plane contributors
// SPDX-License-Identifier: MIT
//
// This Go entrypoint parses labagent subcommands and starts the enrolled agent runtime.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"homelab/labagent/internal/config"
	"homelab/labagent/internal/controlplane"
	"homelab/labagent/internal/discovery"
	"homelab/labagent/internal/logging"
	"homelab/labagent/internal/mcp"
	"homelab/labagent/internal/tools"
)

var newControlPlaneClient = controlplane.NewClient

// main dispatches the requested labagent subcommand.
func main() {
	if len(os.Args) < 2 {
		config.Usage()
		os.Exit(1)
	}

	subcommand := strings.ToLower(os.Args[1])
	switch subcommand {
	case "version":
		fmt.Printf("labagent version %s\n", config.Version)
	case "status":
		fmt.Println("labagent status command is not configured for persistence in this build")
	case "enroll":
		if err := enroll(os.Args[2:]); err != nil {
			log.Fatal(err)
		}
	case "run":
		if err := run(os.Args[2:]); err != nil {
			log.Fatal(err)
		}
	default:
		config.Usage()
		os.Exit(1)
	}
}

// enroll registers the local agent with the control plane and persists the
// returned credentials and recovery certificate.
func enroll(args []string) error {
	cfg, err := config.ParseEnroll(args)
	if err != nil {
		return err
	}

	hostname, err := os.Hostname()
	if err != nil {
		return err
	}

	identity, err := loadRuntimeIdentity(cfg.StateFile)
	if err != nil {
		return fmt.Errorf("load agent state: %w", err)
	}
	recoveryPublicKey, err := identity.EnsureRecoveryKey()
	if err != nil {
		return fmt.Errorf("initialize recovery key: %w", err)
	}

	endpoint, mcpEndpoint := buildAgentEndpoints(cfg.MCPBind, cfg.MCPPort, cfg.MCPAdvertiseURL)

	client := newControlPlaneClient(cfg.ControlPlane)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	response, err := client.Enroll(ctx, controlplane.EnrollRequest{
		EnrollmentToken:   cfg.Token,
		Endpoint:          endpoint,
		MCPEndpoint:       mcpEndpoint,
		DisplayName:       hostname,
		Hostname:          hostname,
		Tags:              []string{"linux", "labagent"},
		AgentVersion:      config.Version,
		RecoveryKeyAlg:    config.RecoveryKeyAlg,
		RecoveryPublicKey: recoveryPublicKey,
	})
	if err != nil {
		return err
	}

	if err := identity.ApplyRecoveredCredentials(response.AgentID, response.AgentToken, response.RecoveryCertificate); err != nil {
		return fmt.Errorf("persist enrolled credentials: %w", err)
	}

	fmt.Println("Enrollment successful")
	fmt.Printf("Agent ID: %s\n", response.AgentID)
	fmt.Printf("State File: %s\n", cfg.StateFile)
	return nil
}

// run builds a signal-aware context and starts the long-running agent runtime.
func run(args []string) error {
	cfg, err := config.ParseRun(args)
	if err != nil {
		return err
	}
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	return runWithContext(ctx, cfg)
}

// runWithContext starts the agent services, performs the initial sync, and
// keeps heartbeat, facts, and inventory updates flowing until shutdown.
func runWithContext(ctx context.Context, cfg config.RunConfig) error {
	cfg, identity, err := resolveRunCredentials(cfg)
	if err != nil {
		return err
	}
	cfg = normalizeLoggingConfig(cfg)
	logger, err := logging.New(logging.Config{
		ServiceName:         "agent",
		Level:               cfg.LogLevel,
		FilePath:            cfg.LogFilePath,
		LogToStdout:         cfg.LogToStdout,
		LogToFile:           cfg.LogToFile,
		RotateFileSizeBytes: cfg.LogRotateBytes,
		RetentionDays:       cfg.LogRetentionDays,
		MaxBytes:            cfg.LogMaxBytes,
	})
	if err != nil {
		return fmt.Errorf("configure logger: %w", err)
	}
	defer logger.Close()
	mcp.SetLogger(logger)
	logger.Info("labagent starting", slog.String("version", config.Version))

	collector := discovery.NewCollector()
	state := tools.NewRuntimeState()
	telemetry := newTelemetryController(cfg)
	executor := tools.NewExecutor(state, tools.TelemetryHooks{
		GetConfig:      telemetry.getConfig,
		SetConfig:      telemetry.setConfig,
		RequestRefresh: telemetry.requestRefresh,
	})
	_, currentAgentToken := identity.Credentials()
	mcpServer := mcp.NewServer(cfg.MCPBind, cfg.MCPPort, currentAgentToken, cfg.AllowedOrigins, executor)
	if err := mcpServer.Start(); err != nil {
		return err
	}

	client := newControlPlaneClient(cfg.ControlPlane)

	// Prime the control plane with the current runtime state before entering
	// the steady-state ticker loop.
	if err := sendHeartbeat(ctx, client, identity, executor); err != nil {
		if err = handleRuntimeError(ctx, logger, client, cfg, identity, collector, state, executor, mcpServer, err); err != nil {
			logger.Warn("initial heartbeat failed", slog.String("reason", err.Error()))
		}
	}
	if err := collectAndSendFacts(ctx, client, identity, collector, state); err != nil {
		if err = handleRuntimeError(ctx, logger, client, cfg, identity, collector, state, executor, mcpServer, err); err != nil {
			logger.Warn("initial facts send failed", slog.String("reason", err.Error()))
		}
	}
	if err := collectAndSendInventory(ctx, client, identity, collector, state); err != nil {
		if err = handleRuntimeError(ctx, logger, client, cfg, identity, collector, state, executor, mcpServer, err); err != nil {
			logger.Warn("initial inventory send failed", slog.String("reason", err.Error()))
		}
	}

	initialIntervals := telemetry.snapshot()
	heartbeatTicker := time.NewTicker(time.Duration(initialIntervals.HeartbeatSec) * time.Second)
	defer heartbeatTicker.Stop()
	factsTicker := time.NewTicker(time.Duration(initialIntervals.FactsSec) * time.Second)
	defer factsTicker.Stop()
	inventoryTicker := time.NewTicker(time.Duration(initialIntervals.InventorySec) * time.Second)
	defer inventoryTicker.Stop()

	logger.Info(
		"labagent running",
		slog.String("version", config.Version),
		slog.String("controlPlane", cfg.ControlPlane),
		slog.String("agentId", identity.AgentID()),
		slog.String("mcpBind", cfg.MCPBind),
		slog.Int("mcpPort", cfg.MCPPort),
	)

	for {
		select {
		case <-ctx.Done():
			shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer shutdownCancel()
			_ = mcpServer.Shutdown(shutdownCtx)
			return nil
		case <-heartbeatTicker.C:
			if err := sendHeartbeat(ctx, client, identity, executor); err != nil {
				if err = handleRuntimeError(ctx, logger, client, cfg, identity, collector, state, executor, mcpServer, err); err != nil {
					logger.Warn("heartbeat failed", slog.String("reason", err.Error()))
				}
			}
		case <-factsTicker.C:
			if err := collectAndSendFacts(ctx, client, identity, collector, state); err != nil {
				if err = handleRuntimeError(ctx, logger, client, cfg, identity, collector, state, executor, mcpServer, err); err != nil {
					logger.Warn("facts collection failed", slog.String("reason", err.Error()))
				}
			}
		case <-inventoryTicker.C:
			if err := collectAndSendInventory(ctx, client, identity, collector, state); err != nil {
				if err = handleRuntimeError(ctx, logger, client, cfg, identity, collector, state, executor, mcpServer, err); err != nil {
					logger.Warn("inventory collection failed", slog.String("reason", err.Error()))
				}
			}
		case updated := <-telemetry.updates():
			heartbeatTicker.Reset(time.Duration(updated.HeartbeatSec) * time.Second)
			factsTicker.Reset(time.Duration(updated.FactsSec) * time.Second)
			inventoryTicker.Reset(time.Duration(updated.InventorySec) * time.Second)
			logger.Info(
				"telemetry intervals updated",
				slog.Int("heartbeatSec", updated.HeartbeatSec),
				slog.Int("factsSec", updated.FactsSec),
				slog.Int("inventorySec", updated.InventorySec),
			)
		case reason := <-telemetry.refreshes():
			logger.Info("telemetry refresh requested", slog.String("reason", reason))
			if err := collectAndSendFacts(ctx, client, identity, collector, state); err != nil {
				if err = handleRuntimeError(ctx, logger, client, cfg, identity, collector, state, executor, mcpServer, err); err != nil {
					logger.Warn("manual facts refresh failed", slog.String("reason", err.Error()))
				}
			}
			if err := collectAndSendInventory(ctx, client, identity, collector, state); err != nil {
				if err = handleRuntimeError(ctx, logger, client, cfg, identity, collector, state, executor, mcpServer, err); err != nil {
					logger.Warn("manual inventory refresh failed", slog.String("reason", err.Error()))
				}
			}
		}
	}
}

// normalizeLoggingConfig fills in runtime logging defaults when callers omit
// them from the run configuration.
func normalizeLoggingConfig(cfg config.RunConfig) config.RunConfig {
	if strings.TrimSpace(cfg.LogLevel) == "" {
		cfg.LogLevel = "info"
	}
	if strings.TrimSpace(cfg.LogFilePath) == "" {
		cfg.LogFilePath = "/var/log/homelab/agent/agent.log"
	}
	if cfg.LogRetentionDays <= 0 {
		cfg.LogRetentionDays = 14
	}
	if cfg.LogMaxBytes <= 0 {
		cfg.LogMaxBytes = 1024 * 1024 * 1024
	}
	if cfg.LogRotateBytes <= 0 {
		cfg.LogRotateBytes = 50 * 1024 * 1024
	}
	if !cfg.LogToStdout && !cfg.LogToFile {
		cfg.LogToStdout = true
	}
	return cfg
}

// sendHeartbeat announces the current runtime capabilities and stores a newly
// issued recovery certificate when the control plane returns one.
func sendHeartbeat(ctx context.Context, client *controlplane.Client, identity *runtimeIdentity, executor *tools.Executor) error {
	agentID, agentToken := identity.Credentials()
	payload := controlplane.HeartbeatRequest{
		Status:  "ONLINE",
		Version: config.Version,
		Capabilities: map[string]interface{}{
			"tools":     executor.ListTools(),
			"resources": executor.ListResources(),
			"prompts":   executor.ListPrompts(),
		},
	}
	if strings.TrimSpace(identity.RecoveryCertificate()) == "" {
		recoveryPublicKey, err := identity.RecoveryPublicKey()
		if err != nil {
			return err
		}
		payload.RecoveryCertificateMissing = true
		payload.RecoveryKeyAlg = config.RecoveryKeyAlg
		payload.RecoveryPublicKey = recoveryPublicKey
	}
	response, err := client.Heartbeat(ctx, agentID, agentToken, payload)
	if err != nil {
		return err
	}
	if response.RecoveryCertificate != "" {
		if err := identity.SetRecoveryCertificate(response.RecoveryCertificate); err != nil {
			return fmt.Errorf("persist recovery certificate: %w", err)
		}
	}
	return nil
}

// collectAndSendFacts snapshots host facts, updates local runtime state, and
// emits derived events once inventory is available for correlation.
func collectAndSendFacts(
	ctx context.Context,
	client *controlplane.Client,
	identity *runtimeIdentity,
	collector *discovery.Collector,
	state *tools.RuntimeState,
) error {
	facts, err := collector.CollectFacts(ctx, config.Version)
	if err != nil {
		return err
	}

	factsMap := mustMap(facts)
	state.UpdateFacts(factsMap)

	agentID, agentToken := identity.Credentials()
	if err := client.Facts(ctx, agentID, agentToken, factsMap); err != nil {
		return err
	}

	inventoryMap := map[string]interface{}{}
	_, inventorySnapshot, _ := state.Snapshot()
	for k, v := range inventorySnapshot {
		inventoryMap[k] = v
	}
	if len(inventoryMap) > 0 {
		events := collector.DetectEvents(facts, mustInventory(inventoryMap))
		if len(events) > 0 {
			eventRecords := make([]map[string]interface{}, 0, len(events))
			for _, event := range events {
				eventRecords = append(eventRecords, mustMap(event))
			}
			state.AppendEvents(eventRecords)
			_ = client.Events(ctx, agentID, agentToken, map[string]interface{}{"events": eventRecords})
		}
	}

	return nil
}

// collectAndSendInventory snapshots services and containers, updates runtime
// state, and emits derived events once facts are already cached.
func collectAndSendInventory(
	ctx context.Context,
	client *controlplane.Client,
	identity *runtimeIdentity,
	collector *discovery.Collector,
	state *tools.RuntimeState,
) error {
	inventory, err := collector.CollectInventory(ctx)
	if err != nil {
		return err
	}
	inventoryMap := mustMap(inventory)
	state.UpdateInventory(inventoryMap)

	agentID, agentToken := identity.Credentials()
	if err := client.Inventory(ctx, agentID, agentToken, inventoryMap); err != nil {
		return err
	}

	factsSnapshot, _, _ := state.Snapshot()
	events := collector.DetectEvents(mustFacts(factsSnapshot), inventory)
	if len(events) > 0 {
		eventRecords := make([]map[string]interface{}, 0, len(events))
		for _, event := range events {
			eventRecords = append(eventRecords, mustMap(event))
		}
		state.AppendEvents(eventRecords)
		_ = client.Events(ctx, agentID, agentToken, map[string]interface{}{"events": eventRecords})
	}

	return nil
}

// handleRuntimeError attempts orphaned-agent recovery when the control plane
// reports that the current agent credentials are no longer registered.
func handleRuntimeError(
	ctx context.Context,
	logger *logging.Logger,
	client *controlplane.Client,
	cfg config.RunConfig,
	identity *runtimeIdentity,
	collector *discovery.Collector,
	runtimeState *tools.RuntimeState,
	executor *tools.Executor,
	mcpServer *mcp.Server,
	err error,
) error {
	var requestErr *controlplane.RequestError
	if !errors.As(err, &requestErr) || requestErr.Code != controlplane.AgentNotRegisteredCode {
		return err
	}
	if recoveryErr := recoverOrphanedAgent(ctx, logger, client, cfg, identity, collector, runtimeState, executor, mcpServer); recoveryErr != nil {
		return recoveryErr
	}
	return nil
}

// mustMap converts a typed payload into a generic map for runtime-state and
// control-plane helper calls.
func mustMap(value interface{}) map[string]interface{} {
	data, _ := json.Marshal(value)
	out := map[string]interface{}{}
	_ = json.Unmarshal(data, &out)
	return out
}

// mustFacts rehydrates a generic map snapshot into typed fact data.
func mustFacts(m map[string]interface{}) discovery.Facts {
	data, _ := json.Marshal(m)
	var facts discovery.Facts
	_ = json.Unmarshal(data, &facts)
	return facts
}

// mustInventory rehydrates a generic map snapshot into typed inventory data.
func mustInventory(m map[string]interface{}) discovery.Inventory {
	data, _ := json.Marshal(m)
	var inventory discovery.Inventory
	_ = json.Unmarshal(data, &inventory)
	return inventory
}

const (
	telemetryMinIntervalSec = 5
	telemetryMaxIntervalSec = 3600
)

type telemetryIntervals struct {
	HeartbeatSec int
	FactsSec     int
	InventorySec int
	UpdatedAt    time.Time
}

type telemetryController struct {
	mu        sync.RWMutex
	intervals telemetryIntervals
	updateCh  chan telemetryIntervals
	refreshCh chan string
}

// newTelemetryController seeds the mutable telemetry intervals from the run
// configuration and prepares the notification channels used by the tool layer.
func newTelemetryController(cfg config.RunConfig) *telemetryController {
	now := time.Now().UTC()
	return &telemetryController{
		intervals: telemetryIntervals{
			HeartbeatSec: clampInterval(cfg.HeartbeatSec),
			FactsSec:     clampInterval(cfg.FactsSec),
			InventorySec: clampInterval(cfg.InventorySec),
			UpdatedAt:    now,
		},
		updateCh:  make(chan telemetryIntervals, 1),
		refreshCh: make(chan string, 1),
	}
}

// snapshot returns the currently active telemetry interval set.
func (t *telemetryController) snapshot() telemetryIntervals {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.intervals
}

// getConfig exposes the current telemetry settings through the tool contract.
func (t *telemetryController) getConfig() tools.TelemetryConfig {
	current := t.snapshot()
	return tools.TelemetryConfig{
		HeartbeatSec: current.HeartbeatSec,
		FactsSec:     current.FactsSec,
		InventorySec: current.InventorySec,
		MinSec:       telemetryMinIntervalSec,
		MaxSec:       telemetryMaxIntervalSec,
		UpdatedAt:    current.UpdatedAt.Format(time.RFC3339),
	}
}

// setConfig validates and applies caller-supplied telemetry interval changes.
func (t *telemetryController) setConfig(patch tools.TelemetryConfigPatch) (tools.TelemetryConfig, error) {
	t.mu.Lock()
	next := t.intervals
	changed := false

	if patch.HeartbeatSec != nil {
		if err := validateTelemetryInterval(*patch.HeartbeatSec); err != nil {
			t.mu.Unlock()
			return tools.TelemetryConfig{}, fmt.Errorf("heartbeatSec %w", err)
		}
		next.HeartbeatSec = *patch.HeartbeatSec
		changed = true
	}
	if patch.FactsSec != nil {
		if err := validateTelemetryInterval(*patch.FactsSec); err != nil {
			t.mu.Unlock()
			return tools.TelemetryConfig{}, fmt.Errorf("factsSec %w", err)
		}
		next.FactsSec = *patch.FactsSec
		changed = true
	}
	if patch.InventorySec != nil {
		if err := validateTelemetryInterval(*patch.InventorySec); err != nil {
			t.mu.Unlock()
			return tools.TelemetryConfig{}, fmt.Errorf("inventorySec %w", err)
		}
		next.InventorySec = *patch.InventorySec
		changed = true
	}

	if changed {
		next.UpdatedAt = time.Now().UTC()
		t.intervals = next
	}
	current := t.intervals
	t.mu.Unlock()

	if changed {
		t.publishUpdate(current)
	}

	return t.getConfig(), nil
}

// requestRefresh queues a best-effort manual refresh signal for the runtime
// loop without blocking the caller.
func (t *telemetryController) requestRefresh(reason string) bool {
	cleanReason := strings.TrimSpace(reason)
	if cleanReason == "" {
		cleanReason = "manual"
	}
	select {
	case t.refreshCh <- cleanReason:
		return true
	default:
		return false
	}
}

// updates exposes the interval-update notification channel.
func (t *telemetryController) updates() <-chan telemetryIntervals {
	return t.updateCh
}

// refreshes exposes the manual refresh notification channel.
func (t *telemetryController) refreshes() <-chan string {
	return t.refreshCh
}

// publishUpdate publishes the newest interval set, dropping the stale buffered
// update when the channel is already full.
func (t *telemetryController) publishUpdate(next telemetryIntervals) {
	select {
	case t.updateCh <- next:
	default:
		select {
		case <-t.updateCh:
		default:
		}
		select {
		case t.updateCh <- next:
		default:
		}
	}
}

// validateTelemetryInterval enforces the allowed telemetry interval bounds.
func validateTelemetryInterval(value int) error {
	if value < telemetryMinIntervalSec || value > telemetryMaxIntervalSec {
		return fmt.Errorf("must be between %d and %d seconds", telemetryMinIntervalSec, telemetryMaxIntervalSec)
	}
	return nil
}

// clampInterval bounds an interval to the supported telemetry range.
func clampInterval(value int) int {
	if value < telemetryMinIntervalSec {
		return telemetryMinIntervalSec
	}
	if value > telemetryMaxIntervalSec {
		return telemetryMaxIntervalSec
	}
	return value
}
