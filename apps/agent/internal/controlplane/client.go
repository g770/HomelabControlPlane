// Copyright (c) 2026 Homelab Control Plane contributors
// SPDX-License-Identifier: MIT
//
// This client wraps the control-plane HTTP API that labagent uses for
// enrollment, telemetry delivery, and recovery-claim workflows.
package controlplane

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const (
	RecoveryKeyAlgEd25519        = "ED25519"
	AgentNotRegisteredCode       = "AGENT_NOT_REGISTERED"
	AgentRevokedCode             = "AGENT_REVOKED"
	AgentTokenInvalidCode        = "AGENT_TOKEN_INVALID"
	RecoveryClaimPendingApproval = "PENDING_APPROVAL"
	RecoveryClaimApproved        = "APPROVED_PENDING_AGENT"
	RecoveryClaimDenied          = "DENIED"
	RecoveryClaimCompleted       = "COMPLETED"
)

type Client struct {
	baseURL    string
	httpClient *http.Client
}

type RequestError struct {
	StatusCode int
	Message    string
	Code       string
}

// Error formats the request failure details for logs and callers.
func (e *RequestError) Error() string {
	if e == nil {
		return ""
	}
	switch {
	case e.Code != "" && e.Message != "":
		return fmt.Sprintf("control plane request failed: %d %s (%s)", e.StatusCode, e.Message, e.Code)
	case e.Message != "":
		return fmt.Sprintf("control plane request failed: %d %s", e.StatusCode, e.Message)
	case e.Code != "":
		return fmt.Sprintf("control plane request failed: %d (%s)", e.StatusCode, e.Code)
	default:
		return fmt.Sprintf("control plane request failed: %d", e.StatusCode)
	}
}

// NewClient builds a control-plane client with the default HTTP timeout.
func NewClient(baseURL string) *Client {
	return NewClientWithHTTPClient(baseURL, &http.Client{
		Timeout: 15 * time.Second,
	})
}

// NewClientWithHTTPClient normalizes the base URL and stores the caller-supplied
// transport so tests and alternate runtimes can override it.
func NewClientWithHTTPClient(baseURL string, httpClient *http.Client) *Client {
	if httpClient == nil {
		httpClient = &http.Client{
			Timeout: 15 * time.Second,
		}
	}
	return &Client{
		baseURL:    strings.TrimRight(baseURL, "/"),
		httpClient: httpClient,
	}
}

type EnrollRequest struct {
	EnrollmentToken   string   `json:"enrollmentToken"`
	Endpoint          string   `json:"endpoint"`
	MCPEndpoint       string   `json:"mcpEndpoint"`
	DisplayName       string   `json:"displayName,omitempty"`
	Hostname          string   `json:"hostname"`
	Tags              []string `json:"tags"`
	AgentVersion      string   `json:"agentVersion"`
	RecoveryKeyAlg    string   `json:"recoveryKeyAlg,omitempty"`
	RecoveryPublicKey string   `json:"recoveryPublicKey,omitempty"`
}

type EnrollResponse struct {
	AgentID             string `json:"agentId"`
	AgentToken          string `json:"agentToken"`
	RecoveryCertificate string `json:"recoveryCertificate"`
}

type HeartbeatRequest struct {
	Status                     string                 `json:"status"`
	Version                    string                 `json:"version"`
	Capabilities               map[string]interface{} `json:"capabilities"`
	RecoveryCertificateMissing bool                   `json:"recoveryCertificateMissing,omitempty"`
	RecoveryKeyAlg             string                 `json:"recoveryKeyAlg,omitempty"`
	RecoveryPublicKey          string                 `json:"recoveryPublicKey,omitempty"`
}

type HeartbeatResponse struct {
	OK                  bool   `json:"ok"`
	RecoveryCertificate string `json:"recoveryCertificate,omitempty"`
}

type ReclaimChallengeResponse struct {
	ChallengeToken string `json:"challengeToken"`
	ExpiresAt      string `json:"expiresAt"`
}

type SubmitReclaimClaimRequest struct {
	ChallengeToken      string   `json:"challengeToken"`
	RecoveryCertificate string   `json:"recoveryCertificate"`
	Signature           string   `json:"signature"`
	Hostname            string   `json:"hostname"`
	PrimaryIP           string   `json:"primaryIp,omitempty"`
	DisplayName         string   `json:"displayName,omitempty"`
	Endpoint            string   `json:"endpoint"`
	MCPEndpoint         string   `json:"mcpEndpoint"`
	AgentVersion        string   `json:"agentVersion,omitempty"`
	Tags                []string `json:"tags"`
}

type SubmitReclaimClaimResponse struct {
	ClaimID   string `json:"claimId"`
	PollToken string `json:"pollToken"`
	Status    string `json:"status"`
}

type ReclaimStatusRequest struct {
	PollToken string `json:"pollToken"`
}

type ReclaimStatusResponse struct {
	Status              string `json:"status"`
	Reason              string `json:"reason,omitempty"`
	AgentID             string `json:"agentId,omitempty"`
	AgentToken          string `json:"agentToken,omitempty"`
	RecoveryCertificate string `json:"recoveryCertificate,omitempty"`
}

type ReclaimAckResponse struct {
	OK               bool `json:"ok"`
	AlreadyCompleted bool `json:"alreadyCompleted,omitempty"`
}

// Enroll exchanges an enrollment token for persistent agent credentials.
func (c *Client) Enroll(ctx context.Context, req EnrollRequest) (EnrollResponse, error) {
	var response EnrollResponse
	err := c.postJSON(ctx, "/api/agents/enroll", "", req, &response)
	return response, err
}

// Heartbeat posts the agent's current runtime status and capabilities.
func (c *Client) Heartbeat(ctx context.Context, agentID, token string, payload HeartbeatRequest) (HeartbeatResponse, error) {
	var response HeartbeatResponse
	err := c.postJSON(ctx, fmt.Sprintf("/api/agents/%s/heartbeat", agentID), token, payload, &response)
	return response, err
}

// Facts sends the latest host fact snapshot for the enrolled agent.
func (c *Client) Facts(ctx context.Context, agentID, token string, payload map[string]interface{}) error {
	return c.postJSON(ctx, fmt.Sprintf("/api/agents/%s/facts", agentID), token, payload, nil)
}

// Inventory sends the latest inventory snapshot for the enrolled agent.
func (c *Client) Inventory(ctx context.Context, agentID, token string, payload map[string]interface{}) error {
	return c.postJSON(ctx, fmt.Sprintf("/api/agents/%s/inventory", agentID), token, payload, nil)
}

// Events sends derived runtime events for the enrolled agent.
func (c *Client) Events(ctx context.Context, agentID, token string, payload map[string]interface{}) error {
	return c.postJSON(ctx, fmt.Sprintf("/api/agents/%s/events", agentID), token, payload, nil)
}

// ReclaimChallenge requests a short-lived challenge token for recovery claims.
func (c *Client) ReclaimChallenge(ctx context.Context) (ReclaimChallengeResponse, error) {
	var response ReclaimChallengeResponse
	err := c.postJSON(ctx, "/api/agents/reclaim/challenge", "", map[string]interface{}{}, &response)
	return response, err
}

// SubmitReclaimClaim posts a signed recovery claim for operator approval.
func (c *Client) SubmitReclaimClaim(ctx context.Context, payload SubmitReclaimClaimRequest) (SubmitReclaimClaimResponse, error) {
	var response SubmitReclaimClaimResponse
	err := c.postJSON(ctx, "/api/agents/reclaim/claims", "", payload, &response)
	return response, err
}

// ReclaimStatus polls the current approval status for a pending recovery claim.
func (c *Client) ReclaimStatus(ctx context.Context, claimID, pollToken string) (ReclaimStatusResponse, error) {
	var response ReclaimStatusResponse
	err := c.postJSON(ctx, fmt.Sprintf("/api/agents/reclaim/claims/%s/status", claimID), "", ReclaimStatusRequest{
		PollToken: pollToken,
	}, &response)
	return response, err
}

// ReclaimAck acknowledges a completed recovery claim so it can be finalized.
func (c *Client) ReclaimAck(ctx context.Context, claimID, pollToken string) (ReclaimAckResponse, error) {
	var response ReclaimAckResponse
	err := c.postJSON(ctx, fmt.Sprintf("/api/agents/reclaim/claims/%s/ack", claimID), "", ReclaimStatusRequest{
		PollToken: pollToken,
	}, &response)
	return response, err
}

// BuildRecoveryClaimMessage produces the canonical newline-delimited payload
// that the agent signs during the recovery-claim flow.
func BuildRecoveryClaimMessage(payload SubmitReclaimClaimRequest) string {
	return strings.Join([]string{
		"agent-recovery-claim:v1",
		strings.TrimSpace(payload.ChallengeToken),
		strings.TrimSpace(payload.Hostname),
		strings.TrimSpace(payload.PrimaryIP),
		strings.TrimSpace(payload.DisplayName),
		strings.TrimSpace(payload.Endpoint),
		strings.TrimSpace(payload.MCPEndpoint),
		strings.TrimSpace(payload.AgentVersion),
		mustJSONString(payload.Tags),
	}, "\n")
}

// postJSON sends a JSON POST request, optionally attaches bearer auth, and
// decodes either the success payload or a structured request error.
func (c *Client) postJSON(ctx context.Context, path string, bearer string, payload interface{}, out interface{}) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if bearer != "" {
		httpReq.Header.Set("Authorization", "Bearer "+bearer)
	}

	httpResp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return err
	}
	defer httpResp.Body.Close()

	respBody, err := io.ReadAll(httpResp.Body)
	if err != nil {
		return err
	}

	if httpResp.StatusCode < 200 || httpResp.StatusCode >= 300 {
		return parseRequestError(httpResp.StatusCode, respBody)
	}

	if out != nil && len(respBody) > 0 {
		if err := json.Unmarshal(respBody, out); err != nil {
			return err
		}
	}

	return nil
}

// parseRequestError normalizes control-plane error responses into RequestError.
func parseRequestError(statusCode int, body []byte) error {
	type errorEnvelope struct {
		StatusCode int         `json:"statusCode"`
		Message    interface{} `json:"message"`
		Code       string      `json:"code"`
	}

	requestErr := &RequestError{
		StatusCode: statusCode,
		Message:    strings.TrimSpace(string(body)),
	}

	var payload errorEnvelope
	if err := json.Unmarshal(body, &payload); err == nil {
		if payload.StatusCode > 0 {
			requestErr.StatusCode = payload.StatusCode
		}
		if payload.Code != "" {
			requestErr.Code = payload.Code
		}
		if message := coerceErrorMessage(payload.Message); message != "" {
			requestErr.Message = message
		}
	}
	return requestErr
}

// coerceErrorMessage flattens string or array error payloads into one message.
func coerceErrorMessage(message interface{}) string {
	switch value := message.(type) {
	case string:
		return strings.TrimSpace(value)
	case []interface{}:
		parts := make([]string, 0, len(value))
		for _, item := range value {
			if part := coerceErrorMessage(item); part != "" {
				parts = append(parts, part)
			}
		}
		return strings.Join(parts, "; ")
	default:
		return ""
	}
}

// mustJSONString serializes values used in the signed recovery-claim payload.
func mustJSONString(value interface{}) string {
	data, _ := json.Marshal(value)
	return string(data)
}
