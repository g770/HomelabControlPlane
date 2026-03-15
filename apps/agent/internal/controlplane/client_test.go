// Copyright (c) 2026 Homelab Control Plane contributors
// SPDX-License-Identifier: MIT
//
// This Go source file implements client test behavior for the lab agent.
package controlplane

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
)

// TestEnrollPostsJSONAndParsesResponse implements test enroll posts jsonand parses response.
func TestEnrollPostsJSONAndParsesResponse(t *testing.T) {
	t.Parallel()

	var capturedPayload EnrollRequest
	client := newFakeClient(t, func(r *http.Request) (*http.Response, error) {
		if r.Method != http.MethodPost {
			t.Fatalf("expected POST, got %s", r.Method)
		}
		if r.URL.Path != "/api/agents/enroll" {
			t.Fatalf("unexpected path: %s", r.URL.Path)
		}
		if got := r.Header.Get("Content-Type"); got != "application/json" {
			t.Fatalf("unexpected content type: %s", got)
		}

		raw, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("read body: %v", err)
		}
		if err := json.Unmarshal(raw, &capturedPayload); err != nil {
			t.Fatalf("decode request: %v", err)
		}

		return jsonResponse(http.StatusOK, EnrollResponse{
			AgentID:             "agent-1",
			AgentToken:          "agent-token",
			RecoveryCertificate: "recovery-cert",
		})
	})

	response, err := client.Enroll(context.Background(), EnrollRequest{
		EnrollmentToken:   "enroll-token",
		Endpoint:          "http://127.0.0.1:8080",
		MCPEndpoint:       "http://127.0.0.1:8081",
		Hostname:          "node-1",
		Tags:              []string{"linux"},
		AgentVersion:      "v0.2.0",
		RecoveryKeyAlg:    RecoveryKeyAlgEd25519,
		RecoveryPublicKey: "cHVibGljLWtleQ==",
	})
	if err != nil {
		t.Fatalf("enroll returned error: %v", err)
	}
	if capturedPayload.EnrollmentToken != "enroll-token" || capturedPayload.RecoveryKeyAlg != RecoveryKeyAlgEd25519 {
		t.Fatalf("unexpected enroll payload: %+v", capturedPayload)
	}
	if response.AgentID != "agent-1" || response.AgentToken != "agent-token" || response.RecoveryCertificate != "recovery-cert" {
		t.Fatalf("unexpected enroll response: %+v", response)
	}
}

// TestHeartbeatIncludesBearerTokenAndParsesResponse implements test heartbeat includes bearer token and parses response.
func TestHeartbeatIncludesBearerTokenAndParsesResponse(t *testing.T) {
	t.Parallel()

	client := newFakeClient(t, func(r *http.Request) (*http.Response, error) {
		if got := r.Header.Get("Authorization"); got != "Bearer agent-token" {
			t.Fatalf("unexpected auth header: %s", got)
		}
		var payload HeartbeatRequest
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode heartbeat payload: %v", err)
		}
		if !payload.RecoveryCertificateMissing || payload.RecoveryKeyAlg != RecoveryKeyAlgEd25519 {
			t.Fatalf("unexpected heartbeat payload: %+v", payload)
		}
		return jsonResponse(http.StatusOK, HeartbeatResponse{
			OK:                  true,
			RecoveryCertificate: "cert-1",
		})
	})

	response, err := client.Heartbeat(context.Background(), "agent-1", "agent-token", HeartbeatRequest{
		Status:                     "ONLINE",
		Version:                    "v0.2.0",
		Capabilities:               map[string]interface{}{"tools": []string{"host.status"}},
		RecoveryCertificateMissing: true,
		RecoveryKeyAlg:             RecoveryKeyAlgEd25519,
		RecoveryPublicKey:          "cHVibGljLWtleQ==",
	})
	if err != nil {
		t.Fatalf("heartbeat returned error: %v", err)
	}
	if !response.OK || response.RecoveryCertificate != "cert-1" {
		t.Fatalf("unexpected heartbeat response: %+v", response)
	}
}

// TestPostJSONReturnsStructuredRequestError implements test post jsonreturns structured request error.
func TestPostJSONReturnsStructuredRequestError(t *testing.T) {
	t.Parallel()

	client := newFakeClient(t, func(_ *http.Request) (*http.Response, error) {
		return jsonResponse(http.StatusUnauthorized, map[string]interface{}{
			"statusCode": 401,
			"message":    "Agent not registered",
			"code":       AgentNotRegisteredCode,
		})
	})

	err := client.Facts(context.Background(), "agent-1", "token", map[string]interface{}{
		"cpuPct": 50,
	})
	if err == nil {
		t.Fatal("expected error for non-2xx status")
	}
	requestErr, ok := err.(*RequestError)
	if !ok {
		t.Fatalf("expected RequestError, got %T", err)
	}
	if requestErr.Code != AgentNotRegisteredCode || requestErr.StatusCode != 401 {
		t.Fatalf("unexpected request error: %+v", requestErr)
	}
	if !strings.Contains(requestErr.Error(), AgentNotRegisteredCode) {
		t.Fatalf("unexpected error text: %v", requestErr)
	}
}

// TestReclaimMethods implements test reclaim methods.
func TestReclaimMethods(t *testing.T) {
	t.Parallel()

	paths := make([]string, 0, 4)
	client := newFakeClient(t, func(r *http.Request) (*http.Response, error) {
		paths = append(paths, r.URL.Path)
		switch r.URL.Path {
		case "/api/agents/reclaim/challenge":
			return jsonResponse(http.StatusOK, ReclaimChallengeResponse{
				ChallengeToken: "challenge-token",
				ExpiresAt:      "2026-03-12T00:00:00Z",
			})
		case "/api/agents/reclaim/claims":
			return jsonResponse(http.StatusOK, SubmitReclaimClaimResponse{
				ClaimID:   "claim-1",
				PollToken: "poll-token",
				Status:    RecoveryClaimPendingApproval,
			})
		case "/api/agents/reclaim/claims/claim-1/status":
			return jsonResponse(http.StatusOK, ReclaimStatusResponse{
				Status:              RecoveryClaimApproved,
				AgentID:             "agent-2",
				AgentToken:          "token-2",
				RecoveryCertificate: "cert-2",
			})
		case "/api/agents/reclaim/claims/claim-1/ack":
			return jsonResponse(http.StatusOK, ReclaimAckResponse{OK: true})
		default:
			t.Fatalf("unexpected path: %s", r.URL.Path)
			return nil, nil
		}
	})

	ctx := context.Background()
	challenge, err := client.ReclaimChallenge(ctx)
	if err != nil || challenge.ChallengeToken != "challenge-token" {
		t.Fatalf("unexpected reclaim challenge result: %+v err=%v", challenge, err)
	}
	claim, err := client.SubmitReclaimClaim(ctx, SubmitReclaimClaimRequest{
		ChallengeToken:      "challenge-token",
		RecoveryCertificate: "cert-1",
		Signature:           "signature",
		Hostname:            "node-1",
		Endpoint:            "http://127.0.0.1:8081",
		MCPEndpoint:         "http://127.0.0.1:8081/mcp",
		Tags:                []string{"linux"},
	})
	if err != nil || claim.ClaimID != "claim-1" {
		t.Fatalf("unexpected reclaim claim result: %+v err=%v", claim, err)
	}
	status, err := client.ReclaimStatus(ctx, "claim-1", "poll-token")
	if err != nil || status.AgentID != "agent-2" {
		t.Fatalf("unexpected reclaim status result: %+v err=%v", status, err)
	}
	ack, err := client.ReclaimAck(ctx, "claim-1", "poll-token")
	if err != nil || !ack.OK {
		t.Fatalf("unexpected reclaim ack result: %+v err=%v", ack, err)
	}

	if len(paths) != 4 {
		t.Fatalf("expected four API calls, got %d", len(paths))
	}
}

// TestBuildRecoveryClaimMessage implements test build recovery claim message.
func TestBuildRecoveryClaimMessage(t *testing.T) {
	t.Parallel()

	message := BuildRecoveryClaimMessage(SubmitReclaimClaimRequest{
		ChallengeToken: "challenge",
		Hostname:       "node-1",
		PrimaryIP:      "10.0.0.5",
		DisplayName:    "node-1",
		Endpoint:       "http://10.0.0.5:8081",
		MCPEndpoint:    "http://10.0.0.5:8081/mcp",
		AgentVersion:   "0.2.0",
		Tags:           []string{"linux", "labagent"},
	})

	if !strings.Contains(message, "agent-recovery-claim:v1") {
		t.Fatalf("unexpected recovery message: %q", message)
	}
	if !strings.Contains(message, "[\"linux\",\"labagent\"]") {
		t.Fatalf("unexpected serialized tags: %q", message)
	}
}

// TestPostJSONDecodeError implements test post jsondecode error.
func TestPostJSONDecodeError(t *testing.T) {
	t.Parallel()

	client := newFakeClient(t, func(_ *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusOK,
			Body:       io.NopCloser(strings.NewReader("{invalid")),
			Header:     make(http.Header),
		}, nil
	})

	var out EnrollResponse
	err := client.postJSON(context.Background(), "/api/agents/enroll", "", map[string]interface{}{"x": "y"}, &out)
	if err == nil {
		t.Fatal("expected decode error for invalid JSON body")
	}
}

// newFakeClient implements new fake client.
func newFakeClient(t *testing.T, handler func(*http.Request) (*http.Response, error)) *Client {
	t.Helper()

	return NewClientWithHTTPClient("http://control-plane.test", &http.Client{
		Transport: roundTripFunc(handler),
	})
}

// jsonResponse implements json response.
func jsonResponse(statusCode int, body interface{}) (*http.Response, error) {
	data, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	return &http.Response{
		StatusCode: statusCode,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(bytes.NewReader(data)),
	}, nil
}

type roundTripFunc func(*http.Request) (*http.Response, error)

// RoundTrip implements round trip.
func (fn roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) {
	return fn(r)
}
