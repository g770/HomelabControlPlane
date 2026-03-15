// Copyright (c) 2026 Homelab Control Plane contributors
// SPDX-License-Identifier: MIT
//
// This Go source file implements helpers test behavior for the lab agent.
package discovery

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestShouldSkipDiskDevice implements test should skip disk device.
func TestShouldSkipDiskDevice(t *testing.T) {
	t.Parallel()

	if !shouldSkipDiskDevice("") {
		t.Fatal("expected empty device to be skipped")
	}
	for _, device := range []string{"loop0", "ram1", "fd0", "sr0", "nvme0n1p1", "mmcblk0p1", "sda1", "xvda2"} {
		if !shouldSkipDiskDevice(device) {
			t.Fatalf("expected %s to be skipped", device)
		}
	}
	for _, device := range []string{"sda", "xvda", "nvme0n1"} {
		if shouldSkipDiskDevice(device) {
			t.Fatalf("did not expect %s to be skipped", device)
		}
	}
}

// TestRuntimeProviderNormalizationAndDetection implements test runtime provider normalization and detection.
func TestRuntimeProviderNormalizationAndDetection(t *testing.T) {
	t.Parallel()

	tests := map[string]string{
		"":                 "",
		"docker-ce":        "docker",
		"podman machine":   "podman",
		"kubepods/besteff": "kubernetes",
		"containerd":       "containerd",
		"lxc":              "lxc",
		"container":        "container",
		"custom":           "custom",
	}
	for input, expected := range tests {
		if got := normalizeRuntimeProvider(input); got != expected {
			t.Fatalf("normalizeRuntimeProvider(%q) = %q, expected %q", input, got, expected)
		}
	}

	if got := detectContainerProviderFromCgroup("10:cpuset:/docker/abc"); got != "docker" {
		t.Fatalf("unexpected cgroup provider: %s", got)
	}
	if got := detectContainerProviderFromCgroup("0::/unknown"); got != "" {
		t.Fatalf("unexpected unknown provider hint: %s", got)
	}
}

// TestAppendUniqueTagAndFileExists implements test append unique tag and file exists.
func TestAppendUniqueTagAndFileExists(t *testing.T) {
	t.Parallel()

	tags := []string{"linux"}
	tags = appendUniqueTag(tags, "labagent")
	tags = appendUniqueTag(tags, "LABAGENT")
	if len(tags) != 2 {
		t.Fatalf("expected deduplicated tags, got %+v", tags)
	}
	tags = appendUniqueTag(tags, " ")
	if len(tags) != 2 {
		t.Fatalf("empty tag should be ignored, got %+v", tags)
	}

	path := filepath.Join(t.TempDir(), "exists.txt")
	if err := os.WriteFile(path, []byte("ok"), 0o600); err != nil {
		t.Fatalf("write temp file: %v", err)
	}
	if !fileExists(path) {
		t.Fatalf("expected file %s to exist", path)
	}
	if fileExists(path + ".missing") {
		t.Fatal("expected missing file to return false")
	}
}

// TestReadKernelAndDistroNeverEmpty implements test read kernel and distro never empty.
func TestReadKernelAndDistroNeverEmpty(t *testing.T) {
	t.Parallel()

	if strings.TrimSpace(readKernelVersion()) == "" {
		t.Fatal("expected non-empty kernel version string")
	}
	if strings.TrimSpace(readDistro()) == "" {
		t.Fatal("expected non-empty distro string")
	}
}

// TestDetectRuntimeAndMarkContainerRuntime implements test detect runtime and mark container runtime.
func TestDetectRuntimeAndMarkContainerRuntime(t *testing.T) {
	t.Parallel()

	info := detectRuntime()
	if _, ok := info["isContainer"]; !ok {
		t.Fatalf("expected runtime map to include isContainer: %+v", info)
	}
	if _, ok := info["provider"]; !ok {
		t.Fatalf("expected runtime map to include provider: %+v", info)
	}

	manual := map[string]interface{}{}
	markContainerRuntime(manual, "docker")
	if manual["isContainer"] != true || manual["provider"] != "docker" {
		t.Fatalf("unexpected marked runtime map: %+v", manual)
	}
}

// TestListInterfaceIPsWithLoopback implements test list interface ips with loopback.
func TestListInterfaceIPsWithLoopback(t *testing.T) {
	t.Parallel()

	interfaces, err := net.Interfaces()
	if err != nil {
		t.Fatalf("net.Interfaces failed: %v", err)
	}
	var loopback *net.Interface
	for i := range interfaces {
		if interfaces[i].Flags&net.FlagLoopback != 0 {
			loopback = &interfaces[i]
			break
		}
	}
	if loopback == nil {
		t.Skip("loopback interface not available")
	}

	ipv4, ipv6 := listInterfaceIPs(*loopback)
	if len(ipv4) == 0 && len(ipv6) == 0 {
		t.Skip("loopback interface has no reported addresses in this environment")
	}
}

// TestCollectFactsAndInventory implements test collect facts and inventory.
func TestCollectFactsAndInventory(t *testing.T) {
	t.Parallel()

	collector := NewCollector()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	facts, err := collector.CollectFacts(ctx, "v-test")
	if err != nil {
		t.Fatalf("CollectFacts failed: %v", err)
	}
	if strings.TrimSpace(facts.Hostname) == "" {
		t.Fatalf("expected hostname in facts payload: %+v", facts)
	}
	if facts.Snapshot == nil {
		t.Fatalf("expected snapshot in facts payload: %+v", facts)
	}
	if facts.AgentVersion != "v-test" {
		t.Fatalf("expected propagated agent version, got %s", facts.AgentVersion)
	}

	inventory, err := collector.CollectInventory(ctx)
	if err != nil {
		t.Fatalf("CollectInventory failed: %v", err)
	}
	if strings.TrimSpace(inventory.Hostname) == "" {
		t.Fatalf("expected inventory hostname: %+v", inventory)
	}
	if inventory.Network == nil || inventory.Storage == nil {
		t.Fatalf("expected inventory network/storage payload: %+v", inventory)
	}
}

// TestLowLevelReadersDoNotPanic implements test low level readers do not panic.
func TestLowLevelReadersDoNotPanic(t *testing.T) {
	t.Parallel()

	collector := NewCollector()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	_, _ = readUptimeSec()
	_, _ = readCPUState()
	_, _ = collector.readCPUPct()
	_, _ = collector.readCPUPct()
	_, _, _, _ = readMemInfo()
	_, _, _ = readDiskInfo(ctx)
	_, _ = readDiskIOSummary()
	_, _ = readNetworkSummary()
	_, _ = listContainers(ctx)
	_, _, _ = listSystemd(ctx)
}
