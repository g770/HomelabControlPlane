// Copyright (c) 2026 Homelab Control Plane contributors
// SPDX-License-Identifier: MIT
//
// This package parses labagent command-line flags, applies environment-backed
// defaults, and validates the resulting runtime configuration.
package config

import (
	"errors"
	"flag"
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
)

const Version = "0.2.0"

type EnrollConfig struct {
	ControlPlane     string
	Token            string
	MCPBind          string
	MCPPort          int
	MCPAdvertiseURL  string
	StateFile        string
	AllowedOrigins   []string
	AllowInsecureDev bool
}

type RunConfig struct {
	ControlPlane     string
	AgentID          string
	AgentToken       string
	MCPBind          string
	MCPPort          int
	MCPAdvertiseURL  string
	StateFile        string
	AllowedOrigins   []string
	AllowInsecureDev bool
	HeartbeatSec     int
	FactsSec         int
	InventorySec     int
	LogLevel         string
	LogToStdout      bool
	LogToFile        bool
	LogFilePath      string
	LogRetentionDays int
	LogMaxBytes      int64
	LogRotateBytes   int64
}

// ParseEnroll parses enrollment flags and validates the resulting config.
func ParseEnroll(args []string) (EnrollConfig, error) {
	fs := flag.NewFlagSet("enroll", flag.ContinueOnError)
	cfg := EnrollConfig{}
	fs.StringVar(&cfg.ControlPlane, "control-plane", "", "Control plane base URL")
	fs.StringVar(&cfg.Token, "token", "", "Enrollment token")
	fs.StringVar(&cfg.MCPBind, "mcp-bind", "127.0.0.1", "MCP bind address")
	fs.IntVar(&cfg.MCPPort, "mcp-port", 8081, "MCP port")
	fs.StringVar(&cfg.MCPAdvertiseURL, "mcp-advertise-url", "", "Advertised MCP base URL reachable by API (for example http://agent-host:8081)")
	fs.StringVar(&cfg.StateFile, "state-file", envOrDefault("AGENT_STATE_FILE", defaultStateFilePath()), "Path to persisted agent state file")
	origins := fs.String("allowed-origins", "http://localhost:5173", "Comma-separated allowed origins")
	fs.BoolVar(&cfg.AllowInsecureDev, "allow-insecure-dev", false, "Allow non-localhost MCP binding without TLS (dev only)")
	if err := fs.Parse(args); err != nil {
		return cfg, err
	}
	cfg.AllowedOrigins = parseOrigins(*origins)
	if err := validateEnroll(cfg); err != nil {
		return cfg, err
	}
	return cfg, nil
}

// ParseRun parses runtime flags, applies environment defaults, and validates
// the resulting run configuration.
func ParseRun(args []string) (RunConfig, error) {
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	cfg := RunConfig{}
	fs.StringVar(&cfg.ControlPlane, "control-plane", "", "Control plane base URL")
	fs.StringVar(&cfg.AgentID, "agent-id", "", "Agent ID")
	fs.StringVar(&cfg.AgentToken, "agent-token", "", "Agent auth token")
	fs.StringVar(&cfg.MCPBind, "mcp-bind", "127.0.0.1", "MCP bind address")
	fs.IntVar(&cfg.MCPPort, "mcp-port", 8081, "MCP port")
	fs.StringVar(&cfg.MCPAdvertiseURL, "mcp-advertise-url", envOrDefault("MCP_ADVERTISE_URL", ""), "Advertised MCP base URL reachable by API (used for recovery claims)")
	fs.StringVar(&cfg.StateFile, "state-file", envOrDefault("AGENT_STATE_FILE", defaultStateFilePath()), "Path to persisted agent state file")
	origins := fs.String("allowed-origins", "http://localhost:5173", "Comma-separated allowed origins")
	fs.BoolVar(&cfg.AllowInsecureDev, "allow-insecure-dev", false, "Allow non-localhost MCP binding without TLS (dev only)")
	fs.IntVar(&cfg.HeartbeatSec, "heartbeat-sec", 15, "Heartbeat interval in seconds")
	fs.IntVar(&cfg.FactsSec, "facts-sec", 300, "Facts interval in seconds")
	fs.IntVar(&cfg.InventorySec, "inventory-sec", 60, "Inventory interval in seconds")
	fs.StringVar(&cfg.LogLevel, "log-level", envOrDefault("AGENT_LOG_LEVEL", "info"), "Log level: error|warn|info|debug|trace")
	fs.BoolVar(&cfg.LogToStdout, "log-to-stdout", parseBoolEnv("LOG_TO_STDOUT", true), "Emit logs to stdout")
	fs.BoolVar(&cfg.LogToFile, "log-to-file", parseBoolEnv("LOG_TO_FILE", true), "Emit logs to file")
	fs.StringVar(&cfg.LogFilePath, "log-file-path", envOrDefault("AGENT_LOG_FILE_PATH", "/var/log/homelab/agent/agent.log"), "Agent log file path")
	fs.IntVar(&cfg.LogRetentionDays, "log-retention-days", parseIntEnv("LOG_RETENTION_DAYS", 14), "Log retention days")
	fs.Int64Var(&cfg.LogMaxBytes, "log-max-bytes", parseInt64Env("LOG_MAX_BYTES_PER_SERVICE", 1024*1024*1024), "Maximum total bytes for service log files")
	fs.Int64Var(&cfg.LogRotateBytes, "log-rotate-bytes", parseInt64Env("LOG_ROTATE_FILE_SIZE_BYTES", 50*1024*1024), "Rotate log file at this size in bytes")
	if err := fs.Parse(args); err != nil {
		return cfg, err
	}
	cfg.AllowedOrigins = parseOrigins(*origins)
	if err := validateRun(cfg); err != nil {
		return cfg, err
	}
	return cfg, nil
}

// parseOrigins splits a comma-separated origin list into trimmed values.
func parseOrigins(raw string) []string {
	parts := strings.Split(raw, ",")
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		trimmed := strings.TrimSpace(part)
		if trimmed != "" {
			result = append(result, trimmed)
		}
	}
	return result
}

// validateEnroll checks the required enrollment settings and network exposure
// rules before labagent attempts to register with the control plane.
func validateEnroll(cfg EnrollConfig) error {
	if cfg.ControlPlane == "" || cfg.Token == "" {
		return errors.New("control-plane and token are required")
	}
	if cfg.MCPPort <= 0 {
		return errors.New("invalid mcp-port")
	}
	if !cfg.AllowInsecureDev && !isLocalBind(cfg.MCPBind) {
		return fmt.Errorf("mcp-bind %s is non-localhost: enable TLS in front or set --allow-insecure-dev for development", cfg.MCPBind)
	}
	if isWildcardBind(cfg.MCPBind) && strings.TrimSpace(cfg.MCPAdvertiseURL) == "" {
		return errors.New("mcp-bind wildcard requires --mcp-advertise-url so API has a routable endpoint")
	}
	if cfg.MCPAdvertiseURL != "" {
		if err := validateAdvertiseURL(cfg.MCPAdvertiseURL); err != nil {
			return err
		}
	}
	if strings.TrimSpace(cfg.StateFile) == "" {
		return errors.New("state-file is required")
	}
	return nil
}

// validateRun checks the required runtime settings, telemetry intervals, and
// logging controls before the agent starts.
func validateRun(cfg RunConfig) error {
	if cfg.ControlPlane == "" {
		return errors.New("control-plane is required")
	}
	if cfg.MCPPort <= 0 || cfg.HeartbeatSec <= 0 || cfg.FactsSec <= 0 || cfg.InventorySec <= 0 {
		return errors.New("intervals and mcp-port must be positive")
	}
	if cfg.LogRetentionDays <= 0 || cfg.LogMaxBytes <= 0 || cfg.LogRotateBytes <= 0 {
		return errors.New("logging retention and size controls must be positive")
	}
	if strings.TrimSpace(cfg.LogFilePath) == "" {
		return errors.New("log-file-path is required")
	}
	if strings.TrimSpace(cfg.StateFile) == "" {
		return errors.New("state-file is required")
	}
	if cfg.MCPAdvertiseURL != "" {
		if err := validateAdvertiseURL(cfg.MCPAdvertiseURL); err != nil {
			return err
		}
	}
	if !cfg.AllowInsecureDev && !isLocalBind(cfg.MCPBind) {
		return fmt.Errorf("mcp-bind %s is non-localhost: enable TLS in front or set --allow-insecure-dev for development", cfg.MCPBind)
	}
	return nil
}

// isLocalBind reports whether the MCP listener stays on loopback-only hosts.
func isLocalBind(bind string) bool {
	return bind == "127.0.0.1" || bind == "localhost" || bind == "::1"
}

// isWildcardBind reports whether the MCP listener is exposed on all addresses.
func isWildcardBind(bind string) bool {
	return bind == "0.0.0.0" || bind == "::"
}

// validateAdvertiseURL ensures the advertised MCP endpoint is routable and
// uses an explicit HTTP(S) scheme.
func validateAdvertiseURL(raw string) error {
	trimmed := strings.TrimSpace(raw)
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return fmt.Errorf("invalid mcp-advertise-url: %w", err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return errors.New("mcp-advertise-url must use http or https")
	}
	if parsed.Host == "" {
		return errors.New("mcp-advertise-url must include host")
	}
	return nil
}

// Usage prints the supported labagent subcommands and their primary flags.
func Usage() {
	fmt.Println("labagent commands:")
	fmt.Println("  labagent enroll --control-plane URL --token TOKEN --mcp-bind ADDR --mcp-port PORT [--mcp-advertise-url URL] [--state-file PATH]")
	fmt.Println("  labagent run --control-plane URL [--agent-id ID --agent-token TOKEN] --mcp-bind ADDR --mcp-port PORT [--mcp-advertise-url URL] [--state-file PATH]")
	fmt.Println("  labagent version")
	fmt.Println("  labagent status")
}

// envOrDefault returns the trimmed environment value or the supplied fallback.
func envOrDefault(key string, fallback string) string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	return value
}

// parseBoolEnv reads a boolean environment value and falls back when it is
// unset or invalid.
func parseBoolEnv(key string, fallback bool) bool {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	switch strings.ToLower(value) {
	case "true", "1", "yes", "on":
		return true
	case "false", "0", "no", "off":
		return false
	default:
		return fallback
	}
}

// parseIntEnv reads a positive integer environment value and falls back when
// it is unset or invalid.
func parseIntEnv(key string, fallback int) int {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}

// parseInt64Env reads a positive int64 environment value and falls back when
// it is unset or invalid.
func parseInt64Env(key string, fallback int64) int64 {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}

// SaveRunConfig writes the recovered runtime credentials into an env-style file
// that later labagent runs can source.
func SaveRunConfig(path string, cfg RunConfig) error {
	content := fmt.Sprintf(
		"AGENT_ID=%s\nAGENT_TOKEN=%s\nCONTROL_PLANE=%s\nAGENT_STATE_FILE=%s\nMCP_ADVERTISE_URL=%s\n",
		cfg.AgentID,
		cfg.AgentToken,
		cfg.ControlPlane,
		cfg.StateFile,
		cfg.MCPAdvertiseURL,
	)
	return os.WriteFile(path, []byte(content), 0600)
}
