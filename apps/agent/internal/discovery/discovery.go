// Copyright (c) 2026 Homelab Control Plane contributors
// SPDX-License-Identifier: MIT
//
// This package collects host facts, inventories local services and containers,
// and derives coarse runtime events for the labagent control-plane feed.
package discovery

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
)

type CPUState struct {
	Idle  uint64
	Total uint64
}

type Collector struct {
	mu           sync.Mutex
	lastCPUState CPUState
	lastDiskPct  float64
	lastMemPct   float64
}

type Facts struct {
	Hostname     string                 `json:"hostname"`
	Tags         []string               `json:"tags"`
	CPUPct       float64                `json:"cpuPct"`
	MemPct       float64                `json:"memPct"`
	DiskPct      float64                `json:"diskPct"`
	Snapshot     map[string]interface{} `json:"snapshot"`
	AgentVersion string                 `json:"agentVersion"`
}

type Inventory struct {
	Hostname   string                   `json:"hostname"`
	Services   []map[string]interface{} `json:"services"`
	Containers []map[string]interface{} `json:"containers"`
	Systemd    map[string]interface{}   `json:"systemd"`
	Network    map[string]interface{}   `json:"network"`
	Storage    map[string]interface{}   `json:"storage"`
}

type Event struct {
	Type     string                 `json:"type"`
	Message  string                 `json:"message"`
	Severity string                 `json:"severity"`
	Payload  map[string]interface{} `json:"payload,omitempty"`
}

// NewCollector constructs a collector that keeps enough prior state to detect
// threshold-crossing events between snapshots.
func NewCollector() *Collector {
	return &Collector{}
}

// CollectFacts gathers the current host metrics and runtime metadata snapshot
// that the agent publishes as its fact payload.
func (c *Collector) CollectFacts(ctx context.Context, agentVersion string) (Facts, error) {
	hostname, err := os.Hostname()
	if err != nil {
		return Facts{}, err
	}

	uptimeSec, err := readUptimeSec()
	if err != nil {
		uptimeSec = 0
	}

	cpuPct, err := c.readCPUPct()
	if err != nil {
		cpuPct = 0
	}

	memTotal, memUsed, memPct, err := readMemInfo()
	if err != nil {
		memTotal, memUsed, memPct = 0, 0, 0
	}

	mounts, diskPct, err := readDiskInfo(ctx)
	if err != nil {
		mounts = []map[string]interface{}{}
		diskPct = 0
	}
	diskIO, err := readDiskIOSummary()
	if err != nil {
		diskIO = map[string]interface{}{}
	}

	netSummary, err := readNetworkSummary()
	if err != nil {
		netSummary = map[string]interface{}{}
	}
	runtimeInfo := detectRuntime()

	osInfo := map[string]interface{}{
		"goos":      runtime.GOOS,
		"goarch":    runtime.GOARCH,
		"kernel":    readKernelVersion(),
		"distro":    readDistro(),
		"uptimeSec": uptimeSec,
		"runtime":   runtimeInfo,
	}

	// Group the raw probe data into the control-plane snapshot contract.
	snapshot := map[string]interface{}{
		"os": osInfo,
		"cpu": map[string]interface{}{
			"cores": runtime.NumCPU(),
			"usage": cpuPct,
		},
		"memory": map[string]interface{}{
			"totalBytes": memTotal,
			"usedBytes":  memUsed,
			"usagePct":   memPct,
		},
		"storage": map[string]interface{}{
			"mounts":   mounts,
			"usagePct": diskPct,
			"io":       diskIO,
		},
		"network": netSummary,
		"runtime": runtimeInfo,
	}
	tags := []string{"linux", "labagent"}
	if isContainer, _ := runtimeInfo["isContainer"].(bool); isContainer {
		tags = appendUniqueTag(tags, "container")
	}
	if provider, ok := runtimeInfo["provider"].(string); ok {
		normalizedProvider := normalizeRuntimeProvider(provider)
		switch normalizedProvider {
		case "docker", "podman", "lxc", "kubernetes", "containerd":
			tags = appendUniqueTag(tags, normalizedProvider)
		}
	}

	facts := Facts{
		Hostname:     hostname,
		Tags:         tags,
		CPUPct:       cpuPct,
		MemPct:       memPct,
		DiskPct:      diskPct,
		Snapshot:     snapshot,
		AgentVersion: agentVersion,
	}

	return facts, nil
}

// CollectInventory enumerates services, containers, network, and storage state
// for the agent inventory payload.
func (c *Collector) CollectInventory(ctx context.Context) (Inventory, error) {
	hostname, err := os.Hostname()
	if err != nil {
		return Inventory{}, err
	}

	containers, _ := listContainers(ctx)
	systemd, services, _ := listSystemd(ctx)
	network, _ := readNetworkSummary()
	mounts, diskPct, _ := readDiskInfo(ctx)

	return Inventory{
		Hostname:   hostname,
		Containers: containers,
		Services:   services,
		Systemd:    systemd,
		Network:    network,
		Storage: map[string]interface{}{
			"mounts":   mounts,
			"usagePct": diskPct,
		},
	}, nil
}

// DetectEvents emits coarse alert-like events from the latest facts and
// inventory snapshots while suppressing repeated threshold crossings.
func (c *Collector) DetectEvents(facts Facts, inventory Inventory) []Event {
	c.mu.Lock()
	defer c.mu.Unlock()

	events := []Event{}

	if facts.CPUPct > 90 {
		events = append(events, Event{
			Type:     "host.cpu.high",
			Message:  fmt.Sprintf("CPU usage is high: %.1f%%", facts.CPUPct),
			Severity: "WARN",
			Payload: map[string]interface{}{
				"cpuPct": facts.CPUPct,
			},
		})
	}

	if facts.MemPct > 90 && c.lastMemPct <= 90 {
		events = append(events, Event{
			Type:     "host.memory.high",
			Message:  fmt.Sprintf("Memory usage crossed threshold: %.1f%%", facts.MemPct),
			Severity: "WARN",
			Payload: map[string]interface{}{
				"memPct": facts.MemPct,
			},
		})
	}

	if facts.DiskPct > 85 && c.lastDiskPct <= 85 {
		events = append(events, Event{
			Type:     "host.disk.high",
			Message:  fmt.Sprintf("Disk usage crossed threshold: %.1f%%", facts.DiskPct),
			Severity: "WARN",
			Payload: map[string]interface{}{
				"diskPct": facts.DiskPct,
			},
		})
	}

	failedCount, _ := inventory.Systemd["failedCount"].(float64)
	if failedCount > 0 {
		events = append(events, Event{
			Type:     "systemd.failed",
			Message:  fmt.Sprintf("Systemd reports %.0f failed units", failedCount),
			Severity: "WARN",
			Payload: map[string]interface{}{
				"failedCount": failedCount,
			},
		})
	}

	c.lastDiskPct = facts.DiskPct
	c.lastMemPct = facts.MemPct

	return events
}

// readUptimeSec reads the kernel uptime counter from /proc/uptime.
func readUptimeSec() (int64, error) {
	data, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return 0, err
	}
	parts := strings.Fields(string(data))
	if len(parts) == 0 {
		return 0, errors.New("invalid uptime format")
	}
	secondsFloat, err := strconv.ParseFloat(parts[0], 64)
	if err != nil {
		return 0, err
	}
	return int64(secondsFloat), nil
}

// readCPUPct converts two successive CPU snapshots into a bounded usage
// percentage for the current collection interval.
func (c *Collector) readCPUPct() (float64, error) {
	state, err := readCPUState()
	if err != nil {
		return 0, err
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	// The first sample only seeds the baseline needed for delta-based CPU usage.
	if c.lastCPUState.Total == 0 {
		c.lastCPUState = state
		return 0, nil
	}

	totalDelta := state.Total - c.lastCPUState.Total
	idleDelta := state.Idle - c.lastCPUState.Idle
	c.lastCPUState = state

	if totalDelta == 0 {
		return 0, nil
	}

	usage := 100 * float64(totalDelta-idleDelta) / float64(totalDelta)
	if usage < 0 {
		usage = 0
	}
	if usage > 100 {
		usage = 100
	}
	return usage, nil
}

// readCPUState reads the aggregate CPU counters from /proc/stat.
func readCPUState() (CPUState, error) {
	data, err := os.ReadFile("/proc/stat")
	if err != nil {
		return CPUState{}, err
	}

	scanner := bufio.NewScanner(bytes.NewReader(data))
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "cpu ") {
			parts := strings.Fields(line)
			if len(parts) < 5 {
				return CPUState{}, errors.New("invalid cpu stat format")
			}
			values := make([]uint64, 0, len(parts)-1)
			for _, part := range parts[1:] {
				v, err := strconv.ParseUint(part, 10, 64)
				if err != nil {
					return CPUState{}, err
				}
				values = append(values, v)
			}
			var total uint64
			for _, v := range values {
				total += v
			}
			idle := values[3]
			if len(values) > 4 {
				idle += values[4]
			}
			return CPUState{Idle: idle, Total: total}, nil
		}
	}
	return CPUState{}, errors.New("cpu line not found")
}

// readMemInfo reads total, used, and percentage memory usage from /proc/meminfo.
func readMemInfo() (uint64, uint64, float64, error) {
	data, err := os.ReadFile("/proc/meminfo")
	if err != nil {
		return 0, 0, 0, err
	}

	vals := map[string]uint64{}
	scanner := bufio.NewScanner(bytes.NewReader(data))
	for scanner.Scan() {
		line := scanner.Text()
		parts := strings.Fields(line)
		if len(parts) < 2 {
			continue
		}
		key := strings.TrimSuffix(parts[0], ":")
		v, err := strconv.ParseUint(parts[1], 10, 64)
		if err != nil {
			continue
		}
		vals[key] = v * 1024
	}

	total := vals["MemTotal"]
	available := vals["MemAvailable"]
	if total == 0 {
		return 0, 0, 0, errors.New("missing mem total")
	}
	used := total - available
	usage := float64(used) * 100 / float64(total)
	return total, used, usage, nil
}

// readDiskInfo shells out to df so mounted filesystems are reported using the
// same view operators see from the host.
func readDiskInfo(ctx context.Context) ([]map[string]interface{}, float64, error) {
	cmd := exec.CommandContext(ctx, "df", "-P", "-k")
	out, err := cmd.Output()
	if err != nil {
		return nil, 0, err
	}

	scanner := bufio.NewScanner(bytes.NewReader(out))
	mounts := []map[string]interface{}{}
	first := true
	var totalBlocks uint64
	var totalUsed uint64
	for scanner.Scan() {
		line := scanner.Text()
		if first {
			first = false
			continue
		}
		parts := strings.Fields(line)
		if len(parts) < 6 {
			continue
		}
		blocks, _ := strconv.ParseUint(parts[1], 10, 64)
		used, _ := strconv.ParseUint(parts[2], 10, 64)
		avail, _ := strconv.ParseUint(parts[3], 10, 64)
		usePctText := strings.TrimSuffix(parts[4], "%")
		usePct, _ := strconv.ParseFloat(usePctText, 64)
		mount := parts[5]

		mounts = append(mounts, map[string]interface{}{
			"filesystem": parts[0],
			"mount":      mount,
			"totalKb":    blocks,
			"usedKb":     used,
			"availKb":    avail,
			"usagePct":   usePct,
		})

		totalBlocks += blocks
		totalUsed += used
	}

	diskPct := 0.0
	if totalBlocks > 0 {
		diskPct = float64(totalUsed) * 100 / float64(totalBlocks)
	}

	return mounts, diskPct, nil
}

// readDiskIOSummary summarizes disk IO counters from /proc/diskstats.
func readDiskIOSummary() (map[string]interface{}, error) {
	data, err := os.ReadFile("/proc/diskstats")
	if err != nil {
		return nil, err
	}

	const sectorSize = uint64(512)
	devices := []map[string]interface{}{}
	var totalReadBytes uint64
	var totalWriteBytes uint64

	scanner := bufio.NewScanner(bytes.NewReader(data))
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 14 {
			continue
		}

		device := fields[2]
		if shouldSkipDiskDevice(device) {
			continue
		}

		readsCompleted, err := strconv.ParseUint(fields[3], 10, 64)
		if err != nil {
			continue
		}
		readSectors, err := strconv.ParseUint(fields[5], 10, 64)
		if err != nil {
			continue
		}
		writesCompleted, err := strconv.ParseUint(fields[7], 10, 64)
		if err != nil {
			continue
		}
		writeSectors, err := strconv.ParseUint(fields[9], 10, 64)
		if err != nil {
			continue
		}
		ioTimeMs, err := strconv.ParseUint(fields[12], 10, 64)
		if err != nil {
			ioTimeMs = 0
		}

		readBytes := readSectors * sectorSize
		writeBytes := writeSectors * sectorSize
		totalReadBytes += readBytes
		totalWriteBytes += writeBytes

		devices = append(devices, map[string]interface{}{
			"name":            device,
			"readBytes":       readBytes,
			"writeBytes":      writeBytes,
			"readsCompleted":  readsCompleted,
			"writesCompleted": writesCompleted,
			"ioTimeMs":        ioTimeMs,
		})
	}

	return map[string]interface{}{
		"readBytes":  totalReadBytes,
		"writeBytes": totalWriteBytes,
		"devices":    devices,
	}, nil
}

// shouldSkipDiskDevice filters pseudo-devices and partitions that would
// otherwise double-count the parent block device.
func shouldSkipDiskDevice(device string) bool {
	if device == "" {
		return true
	}

	if strings.HasPrefix(device, "loop") || strings.HasPrefix(device, "ram") || strings.HasPrefix(device, "fd") || strings.HasPrefix(device, "sr") {
		return true
	}

	// Skip partition slices to avoid double-counting against parent block devices.
	if strings.HasPrefix(device, "nvme") && strings.Contains(device, "p") {
		return true
	}
	if strings.HasPrefix(device, "mmcblk") && strings.Contains(device, "p") {
		return true
	}
	if strings.HasPrefix(device, "sd") || strings.HasPrefix(device, "vd") || strings.HasPrefix(device, "xvd") || strings.HasPrefix(device, "hd") {
		last := device[len(device)-1]
		if last >= '0' && last <= '9' {
			return true
		}
	}
	return false
}

// readNetworkSummary combines /proc/net/dev counters with interface-address
// lookups so the control plane gets both traffic stats and usable IPs.
func readNetworkSummary() (map[string]interface{}, error) {
	data, err := os.ReadFile("/proc/net/dev")
	if err != nil {
		return nil, err
	}

	type ifaceStats struct {
		Rx uint64
		Tx uint64
	}

	statsByName := map[string]ifaceStats{}
	order := []string{}

	interfaces := []map[string]interface{}{}
	scanner := bufio.NewScanner(bytes.NewReader(data))
	lineNumber := 0
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		lineNumber++
		if lineNumber <= 2 || line == "" {
			continue
		}

		parts := strings.Split(line, ":")
		if len(parts) != 2 {
			continue
		}
		iface := strings.TrimSpace(parts[0])
		fields := strings.Fields(parts[1])
		if len(fields) < 16 {
			continue
		}
		rx, _ := strconv.ParseUint(fields[0], 10, 64)
		tx, _ := strconv.ParseUint(fields[8], 10, 64)
		statsByName[iface] = ifaceStats{Rx: rx, Tx: tx}
		order = append(order, iface)
	}

	sysIfaces, _ := net.Interfaces()
	ifaceByName := map[string]net.Interface{}
	for _, iface := range sysIfaces {
		ifaceByName[iface.Name] = iface
	}

	seen := map[string]struct{}{}
	primaryIp := ""
	for _, ifaceName := range order {
		stats := statsByName[ifaceName]
		entry := map[string]interface{}{
			"name":    ifaceName,
			"rxBytes": stats.Rx,
			"txBytes": stats.Tx,
		}
		if iface, ok := ifaceByName[ifaceName]; ok {
			ipv4Addrs, ipv6Addrs := listInterfaceIPs(iface)
			if len(ipv4Addrs) > 0 {
				entry["ipv4"] = ipv4Addrs[0]
				entry["ipv4Addrs"] = ipv4Addrs
				if primaryIp == "" {
					primaryIp = ipv4Addrs[0]
				}
			}
			if len(ipv6Addrs) > 0 {
				entry["ipv6"] = ipv6Addrs[0]
				entry["ipv6Addrs"] = ipv6Addrs
				if primaryIp == "" {
					primaryIp = ipv6Addrs[0]
				}
			}
		}
		interfaces = append(interfaces, entry)
		seen[ifaceName] = struct{}{}
	}

	for _, iface := range sysIfaces {
		if _, exists := seen[iface.Name]; exists {
			continue
		}
		entry := map[string]interface{}{
			"name":    iface.Name,
			"rxBytes": uint64(0),
			"txBytes": uint64(0),
		}
		ipv4Addrs, ipv6Addrs := listInterfaceIPs(iface)
		if len(ipv4Addrs) > 0 {
			entry["ipv4"] = ipv4Addrs[0]
			entry["ipv4Addrs"] = ipv4Addrs
			if primaryIp == "" {
				primaryIp = ipv4Addrs[0]
			}
		}
		if len(ipv6Addrs) > 0 {
			entry["ipv6"] = ipv6Addrs[0]
			entry["ipv6Addrs"] = ipv6Addrs
			if primaryIp == "" {
				primaryIp = ipv6Addrs[0]
			}
		}
		interfaces = append(interfaces, entry)
	}

	return map[string]interface{}{
		"primaryIp":  primaryIp,
		"interfaces": interfaces,
	}, nil
}

// listInterfaceIPs returns non-loopback IPv4 and IPv6 addresses for one
// interface.
func listInterfaceIPs(iface net.Interface) ([]string, []string) {
	if (iface.Flags & net.FlagLoopback) != 0 {
		return []string{}, []string{}
	}
	addrs, err := iface.Addrs()
	if err != nil {
		return []string{}, []string{}
	}

	ipv4Addrs := []string{}
	ipv6Addrs := []string{}
	for _, addr := range addrs {
		var ip net.IP
		switch typed := addr.(type) {
		case *net.IPNet:
			ip = typed.IP
		case *net.IPAddr:
			ip = typed.IP
		default:
			continue
		}
		if ip == nil || ip.IsLoopback() {
			continue
		}
		if v4 := ip.To4(); v4 != nil {
			ipv4Addrs = append(ipv4Addrs, v4.String())
			continue
		}
		ipv6Addrs = append(ipv6Addrs, ip.String())
	}
	return ipv4Addrs, ipv6Addrs
}

// listContainers returns Docker container metadata when the local Docker socket
// is available and otherwise degrades to an empty list.
func listContainers(ctx context.Context) ([]map[string]interface{}, error) {
	if _, err := os.Stat("/var/run/docker.sock"); err != nil {
		return []map[string]interface{}{}, nil
	}
	cmd := exec.CommandContext(ctx, "docker", "ps", "--format", "{{json .}}")
	out, err := cmd.Output()
	if err != nil {
		return []map[string]interface{}{}, nil
	}

	scanner := bufio.NewScanner(bytes.NewReader(out))
	containers := []map[string]interface{}{}
	for scanner.Scan() {
		line := scanner.Text()
		if strings.TrimSpace(line) == "" {
			continue
		}
		row := map[string]string{}
		if err := json.Unmarshal([]byte(line), &row); err != nil {
			continue
		}
		containers = append(containers, map[string]interface{}{
			"id":     row["ID"],
			"name":   row["Names"],
			"image":  row["Image"],
			"status": row["Status"],
		})
	}

	return containers, nil
}

// listSystemd enumerates systemd services and derives a coarse health status
// from each unit's load, active, and sub-state fields.
func listSystemd(ctx context.Context) (map[string]interface{}, []map[string]interface{}, error) {
	services := []map[string]interface{}{}
	failedCount := 0

	listCmd := exec.CommandContext(ctx, "systemctl", "list-units", "--type=service", "--all", "--no-legend", "--no-pager")
	out, err := listCmd.Output()
	if err == nil {
		scanner := bufio.NewScanner(bytes.NewReader(out))
		for scanner.Scan() {
			line := strings.TrimSpace(scanner.Text())
			if line == "" {
				continue
			}
			parts := strings.Fields(line)
			if len(parts) < 4 {
				continue
			}
			name := parts[0]
			loadState := parts[1]
			activeState := parts[2]
			subState := parts[3]
			description := ""
			if len(parts) > 4 {
				description = strings.Join(parts[4:], " ")
			}
			if subState == "failed" {
				failedCount++
			}
			status := "OK"
			if subState == "failed" {
				status = "CRIT"
			} else if subState != "running" {
				status = "WARN"
			}
			metadata := map[string]interface{}{
				"runtime": "systemd",
				"state":   subState,
			}
			if loadState != "" {
				metadata["load"] = loadState
			}
			if activeState != "" {
				metadata["active"] = activeState
			}
			if description != "" {
				metadata["description"] = description
			}
			services = append(services, map[string]interface{}{
				"name":     name,
				"status":   status,
				"state":    subState,
				"metadata": metadata,
			})
		}
	}

	systemd := map[string]interface{}{
		"failedCount": failedCount,
		"units":       services,
	}
	return systemd, services, nil
}

// readKernelVersion reports the running kernel release string.
func readKernelVersion() string {
	data, err := os.ReadFile("/proc/sys/kernel/osrelease")
	if err != nil {
		return "unknown"
	}
	return strings.TrimSpace(string(data))
}

// readDistro extracts PRETTY_NAME from /etc/os-release.
func readDistro() string {
	data, err := os.ReadFile("/etc/os-release")
	if err != nil {
		return "unknown"
	}
	lines := strings.Split(string(data), "\n")
	for _, line := range lines {
		if strings.HasPrefix(line, "PRETTY_NAME=") {
			return strings.Trim(strings.TrimPrefix(line, "PRETTY_NAME="), "\"")
		}
	}
	return "unknown"
}

// detectRuntime combines multiple local probes to infer whether labagent is
// running on bare metal or inside a container runtime.
func detectRuntime() map[string]interface{} {
	result := map[string]interface{}{
		"isContainer": false,
		"provider":    "machine",
	}

	if fileExists("/.dockerenv") {
		markContainerRuntime(result, "docker")
	}
	if fileExists("/run/.containerenv") {
		markContainerRuntime(result, "podman")
	}

	if data, err := os.ReadFile("/run/systemd/container"); err == nil {
		value := normalizeRuntimeProvider(strings.TrimSpace(string(data)))
		if value != "" && value != "machine" {
			markContainerRuntime(result, value)
			result["systemdContainer"] = value
		}
	}

	if containerEnv := normalizeRuntimeProvider(strings.TrimSpace(os.Getenv("container"))); containerEnv != "" && containerEnv != "machine" {
		markContainerRuntime(result, containerEnv)
		result["containerEnv"] = containerEnv
	}

	if cgroupData, err := os.ReadFile("/proc/1/cgroup"); err == nil {
		hint := detectContainerProviderFromCgroup(string(cgroupData))
		if hint != "" {
			markContainerRuntime(result, hint)
			result["cgroupHint"] = hint
		}
	}

	return result
}

// markContainerRuntime marks the runtime probe result as containerized and
// records the normalized provider name.
func markContainerRuntime(runtimeInfo map[string]interface{}, provider string) {
	normalized := normalizeRuntimeProvider(provider)
	if normalized == "" {
		normalized = "container"
	}
	runtimeInfo["isContainer"] = true
	runtimeInfo["provider"] = normalized
}

// normalizeRuntimeProvider collapses environment-specific runtime names into
// the smaller set used by agent tags and snapshots.
func normalizeRuntimeProvider(value string) string {
	lower := strings.ToLower(strings.TrimSpace(value))
	switch {
	case lower == "":
		return ""
	case strings.Contains(lower, "docker"):
		return "docker"
	case strings.Contains(lower, "podman"):
		return "podman"
	case strings.Contains(lower, "kubepods"), strings.Contains(lower, "kube"), strings.Contains(lower, "kubernetes"):
		return "kubernetes"
	case strings.Contains(lower, "containerd"):
		return "containerd"
	case strings.Contains(lower, "lxc"):
		return "lxc"
	case strings.Contains(lower, "container"):
		return "container"
	default:
		return lower
	}
}

// detectContainerProviderFromCgroup infers a likely container runtime from the
// init cgroup paths when other probes are unavailable.
func detectContainerProviderFromCgroup(content string) string {
	lower := strings.ToLower(content)
	switch {
	case strings.Contains(lower, "docker"):
		return "docker"
	case strings.Contains(lower, "podman"):
		return "podman"
	case strings.Contains(lower, "kubepods"), strings.Contains(lower, "kube"):
		return "kubernetes"
	case strings.Contains(lower, "containerd"):
		return "containerd"
	case strings.Contains(lower, "lxc"):
		return "lxc"
	case strings.Contains(lower, "container"):
		return "container"
	default:
		return ""
	}
}

// appendUniqueTag appends a tag only when the value is non-empty and not
// already present case-insensitively.
func appendUniqueTag(tags []string, value string) []string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return tags
	}
	for _, existing := range tags {
		if strings.EqualFold(existing, trimmed) {
			return tags
		}
	}
	return append(tags, trimmed)
}

// fileExists reports whether the supplied path currently exists.
func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
