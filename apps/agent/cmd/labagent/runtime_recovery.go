// Copyright (c) 2026 Homelab Control Plane contributors
// SPDX-License-Identifier: MIT
//
// This Go source file implements runtime recovery behavior for the lab agent.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"homelab/labagent/internal/config"
	"homelab/labagent/internal/controlplane"
	"homelab/labagent/internal/discovery"
	"homelab/labagent/internal/logging"
	"homelab/labagent/internal/mcp"
	"homelab/labagent/internal/tools"
)

var (
	reclaimPollInterval  = 5 * time.Second
	reclaimRetryInterval = 3 * time.Second
)

type runtimeIdentity struct {
	mu    sync.RWMutex
	path  string
	state config.AgentState
}

type recoveryMetadata struct {
	Hostname     string
	PrimaryIP    string
	DisplayName  string
	Endpoint     string
	MCPEndpoint  string
	AgentVersion string
	Tags         []string
}

// loadRuntimeIdentity loads runtime identity.
func loadRuntimeIdentity(path string) (*runtimeIdentity, error) {
	state, _, err := config.LoadAgentStateIfExists(path)
	if err != nil {
		return nil, err
	}
	return &runtimeIdentity{
		path:  path,
		state: state,
	}, nil
}

// resolveRunCredentials implements resolve run credentials.
func resolveRunCredentials(cfg config.RunConfig) (config.RunConfig, *runtimeIdentity, error) {
	identity, err := loadRuntimeIdentity(cfg.StateFile)
	if err != nil {
		return cfg, nil, fmt.Errorf("load agent state: %w", err)
	}

	if _, err := identity.EnsureRecoveryKey(); err != nil {
		return cfg, nil, fmt.Errorf("initialize recovery key: %w", err)
	}

	agentID, agentToken := identity.Credentials()
	switch {
	case agentID != "" && agentToken != "":
		cfg.AgentID = agentID
		cfg.AgentToken = agentToken
	case strings.TrimSpace(cfg.AgentID) != "" && strings.TrimSpace(cfg.AgentToken) != "":
		cfg.AgentID = strings.TrimSpace(cfg.AgentID)
		cfg.AgentToken = strings.TrimSpace(cfg.AgentToken)
		if err := identity.SetRuntimeCredentials(cfg.AgentID, cfg.AgentToken); err != nil {
			return cfg, nil, fmt.Errorf("persist runtime credentials: %w", err)
		}
	default:
		return cfg, nil, fmt.Errorf("agent credentials are required via state file %s or --agent-id/--agent-token", cfg.StateFile)
	}

	return cfg, identity, nil
}

// Credentials implements credentials.
func (r *runtimeIdentity) Credentials() (string, string) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.state.AgentID, r.state.AgentToken
}

// AgentID implements agent id.
func (r *runtimeIdentity) AgentID() string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.state.AgentID
}

// RecoveryCertificate implements recovery certificate.
func (r *runtimeIdentity) RecoveryCertificate() string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.state.RecoveryCertificate
}

// RecoveryPublicKey implements recovery public key.
func (r *runtimeIdentity) RecoveryPublicKey() (string, error) {
	r.mu.RLock()
	state := r.state
	r.mu.RUnlock()
	return state.RecoveryPublicKey()
}

// SignRecoveryClaim implements sign recovery claim.
func (r *runtimeIdentity) SignRecoveryClaim(message string) (string, error) {
	r.mu.RLock()
	state := r.state
	r.mu.RUnlock()
	return state.SignRecoveryClaim(message)
}

// EnsureRecoveryKey implements ensure recovery key.
func (r *runtimeIdentity) EnsureRecoveryKey() (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	next := r.state
	publicKey, err := next.EnsureRecoveryKey()
	if err != nil {
		return "", err
	}
	if next.RecoveryPrivateKey != r.state.RecoveryPrivateKey {
		if err := config.SaveAgentState(r.path, next); err != nil {
			return "", err
		}
		r.state = next
	}
	return publicKey, nil
}

// SetRuntimeCredentials implements set runtime credentials.
func (r *runtimeIdentity) SetRuntimeCredentials(agentID string, agentToken string) error {
	return r.update(func(state *config.AgentState) bool {
		nextAgentID := strings.TrimSpace(agentID)
		nextAgentToken := strings.TrimSpace(agentToken)
		if state.AgentID == nextAgentID && state.AgentToken == nextAgentToken {
			return false
		}
		state.AgentID = nextAgentID
		state.AgentToken = nextAgentToken
		return true
	})
}

// SetRecoveryCertificate implements set recovery certificate.
func (r *runtimeIdentity) SetRecoveryCertificate(certificate string) error {
	return r.update(func(state *config.AgentState) bool {
		nextCertificate := strings.TrimSpace(certificate)
		if nextCertificate == "" || state.RecoveryCertificate == nextCertificate {
			return false
		}
		state.RecoveryCertificate = nextCertificate
		return true
	})
}

// ApplyRecoveredCredentials implements apply recovered credentials.
func (r *runtimeIdentity) ApplyRecoveredCredentials(agentID string, agentToken string, recoveryCertificate string) error {
	return r.update(func(state *config.AgentState) bool {
		nextAgentID := strings.TrimSpace(agentID)
		nextAgentToken := strings.TrimSpace(agentToken)
		nextCertificate := strings.TrimSpace(recoveryCertificate)
		if state.AgentID == nextAgentID && state.AgentToken == nextAgentToken && state.RecoveryCertificate == nextCertificate {
			return false
		}
		state.AgentID = nextAgentID
		state.AgentToken = nextAgentToken
		state.RecoveryCertificate = nextCertificate
		return true
	})
}

// update implements update.
func (r *runtimeIdentity) update(mutate func(state *config.AgentState) bool) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	next := r.state
	if !mutate(&next) {
		return nil
	}
	if err := config.SaveAgentState(r.path, next); err != nil {
		return err
	}
	r.state = next
	return nil
}

// buildAgentEndpoints builds agent endpoints.
func buildAgentEndpoints(bind string, port int, advertiseURL string) (string, string) {
	baseURL := strings.TrimSpace(advertiseURL)
	if baseURL == "" {
		baseURL = fmt.Sprintf("http://%s", net.JoinHostPort(strings.TrimSpace(bind), strconv.Itoa(port)))
	}
	baseURL = strings.TrimRight(baseURL, "/")
	return baseURL, baseURL + "/mcp"
}

// collectRecoveryMetadata implements collect recovery metadata.
func collectRecoveryMetadata(ctx context.Context, cfg config.RunConfig, collector *discovery.Collector) recoveryMetadata {
	endpoint, mcpEndpoint := buildAgentEndpoints(cfg.MCPBind, cfg.MCPPort, cfg.MCPAdvertiseURL)
	metadata := recoveryMetadata{
		Endpoint:     endpoint,
		MCPEndpoint:  mcpEndpoint,
		AgentVersion: config.Version,
		Tags:         []string{"linux", "labagent"},
	}

	hostname, err := os.Hostname()
	if err == nil && strings.TrimSpace(hostname) != "" {
		metadata.Hostname = hostname
		metadata.DisplayName = hostname
	}

	facts, err := collector.CollectFacts(ctx, config.Version)
	if err != nil {
		return metadata
	}
	if strings.TrimSpace(facts.Hostname) != "" {
		metadata.Hostname = strings.TrimSpace(facts.Hostname)
		metadata.DisplayName = metadata.Hostname
	}
	if len(facts.Tags) > 0 {
		metadata.Tags = facts.Tags
	}
	metadata.PrimaryIP = extractPrimaryIP(facts.Snapshot)
	return metadata
}

// extractPrimaryIP implements extract primary ip.
func extractPrimaryIP(snapshot map[string]interface{}) string {
	networkSnapshot, ok := snapshot["network"].(map[string]interface{})
	if !ok {
		return ""
	}
	primaryIP, _ := networkSnapshot["primaryIp"].(string)
	return strings.TrimSpace(primaryIP)
}

// recoverOrphanedAgent implements recover orphaned agent.
func recoverOrphanedAgent(
	ctx context.Context,
	logger *logging.Logger,
	client *controlplane.Client,
	cfg config.RunConfig,
	identity *runtimeIdentity,
	collector *discovery.Collector,
	runtimeState *tools.RuntimeState,
	executor *tools.Executor,
	mcpServer *mcp.Server,
) error {
	if _, err := identity.EnsureRecoveryKey(); err != nil {
		return fmt.Errorf("ensure recovery key: %w", err)
	}
	recoveryCertificate := strings.TrimSpace(identity.RecoveryCertificate())
	if recoveryCertificate == "" {
		return fmt.Errorf("missing recovery certificate in %s; re-enroll the agent", cfg.StateFile)
	}

	metadata := collectRecoveryMetadata(ctx, cfg, collector)
	logger.Warn(
		"agent is not registered; entering orphan recovery",
		slog.String("stateFile", cfg.StateFile),
	)

	var claim *controlplane.SubmitReclaimClaimResponse
	appliedCredentials := false
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if claim == nil {
			challenge, err := client.ReclaimChallenge(ctx)
			if err != nil {
				logger.Warn("recovery challenge failed", slog.String("reason", err.Error()))
				if err := waitForRecoveryInterval(ctx, reclaimRetryInterval); err != nil {
					return err
				}
				continue
			}

			request := controlplane.SubmitReclaimClaimRequest{
				ChallengeToken:      challenge.ChallengeToken,
				RecoveryCertificate: recoveryCertificate,
				Hostname:            metadata.Hostname,
				PrimaryIP:           metadata.PrimaryIP,
				DisplayName:         metadata.DisplayName,
				Endpoint:            metadata.Endpoint,
				MCPEndpoint:         metadata.MCPEndpoint,
				AgentVersion:        metadata.AgentVersion,
				Tags:                metadata.Tags,
			}
			message := controlplane.BuildRecoveryClaimMessage(request)
			signature, err := identity.SignRecoveryClaim(message)
			if err != nil {
				return fmt.Errorf("sign recovery claim: %w", err)
			}
			request.Signature = signature

			submitted, err := client.SubmitReclaimClaim(ctx, request)
			if err != nil {
				logger.Warn("recovery claim submit failed", slog.String("reason", err.Error()))
				if err := waitForRecoveryInterval(ctx, reclaimRetryInterval); err != nil {
					return err
				}
				continue
			}
			claim = &submitted
			logger.Warn("recovery claim submitted; waiting for approval", slog.String("claimId", claim.ClaimID))
		}

		status, err := client.ReclaimStatus(ctx, claim.ClaimID, claim.PollToken)
		if err != nil {
			logger.Warn("recovery claim status failed", slog.String("claimId", claim.ClaimID), slog.String("reason", err.Error()))
			if err := waitForRecoveryInterval(ctx, reclaimPollInterval); err != nil {
				return err
			}
			continue
		}

		switch status.Status {
		case controlplane.RecoveryClaimPendingApproval:
			if err := waitForRecoveryInterval(ctx, reclaimPollInterval); err != nil {
				return err
			}
		case controlplane.RecoveryClaimDenied:
			return fmt.Errorf("recovery claim denied: %s", strings.TrimSpace(status.Reason))
		case controlplane.RecoveryClaimCompleted:
			return nil
		case controlplane.RecoveryClaimApproved:
			if !appliedCredentials {
				if err := identity.ApplyRecoveredCredentials(status.AgentID, status.AgentToken, status.RecoveryCertificate); err != nil {
					return fmt.Errorf("persist recovered credentials: %w", err)
				}
				mcpServer.SetAgentToken(status.AgentToken)
				appliedCredentials = true
				logger.Info("recovery credentials applied", slog.String("claimId", claim.ClaimID), slog.String("agentId", status.AgentID))
			}

			if err := syncRecoveredAgent(ctx, client, identity, collector, runtimeState, executor); err != nil {
				logger.Warn("post-recovery sync failed", slog.String("claimId", claim.ClaimID), slog.String("reason", err.Error()))
				if err := waitForRecoveryInterval(ctx, reclaimRetryInterval); err != nil {
					return err
				}
				continue
			}

			if _, err := client.ReclaimAck(ctx, claim.ClaimID, claim.PollToken); err != nil {
				logger.Warn("recovery ack failed", slog.String("claimId", claim.ClaimID), slog.String("reason", err.Error()))
				if err := waitForRecoveryInterval(ctx, reclaimRetryInterval); err != nil {
					return err
				}
				continue
			}
			return nil
		default:
			return fmt.Errorf("unexpected recovery claim status %q", status.Status)
		}
	}
}

// syncRecoveredAgent implements sync recovered agent.
func syncRecoveredAgent(
	ctx context.Context,
	client *controlplane.Client,
	identity *runtimeIdentity,
	collector *discovery.Collector,
	runtimeState *tools.RuntimeState,
	executor *tools.Executor,
) error {
	if err := sendHeartbeat(ctx, client, identity, executor); err != nil {
		return err
	}
	if err := collectAndSendFacts(ctx, client, identity, collector, runtimeState); err != nil {
		return err
	}
	if err := collectAndSendInventory(ctx, client, identity, collector, runtimeState); err != nil {
		return err
	}
	return nil
}

// waitForRecoveryInterval implements wait for recovery interval.
func waitForRecoveryInterval(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()

	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
