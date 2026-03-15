// Copyright (c) 2026 Homelab Control Plane contributors
// SPDX-License-Identifier: MIT
//
// This Go source file implements discovery test behavior for the lab agent.
package discovery

import "testing"

// TestDetectEventsThresholdsAndCrossingBehavior implements test detect events thresholds and crossing behavior.
func TestDetectEventsThresholdsAndCrossingBehavior(t *testing.T) {
	t.Parallel()

	collector := NewCollector()

	first := collector.DetectEvents(
		Facts{
			CPUPct:  95,
			MemPct:  92,
			DiskPct: 90,
		},
		Inventory{
			Systemd: map[string]interface{}{
				"failedCount": float64(2),
			},
		},
	)

	if len(first) != 4 {
		t.Fatalf("expected 4 events on first sample, got %d", len(first))
	}

	second := collector.DetectEvents(
		Facts{
			CPUPct:  93,
			MemPct:  93,
			DiskPct: 91,
		},
		Inventory{
			Systemd: map[string]interface{}{
				"failedCount": float64(0),
			},
		},
	)

	if len(second) != 1 {
		t.Fatalf("expected only CPU event after threshold crossing established, got %d", len(second))
	}
	if second[0].Type != "host.cpu.high" {
		t.Fatalf("unexpected follow-up event type: %s", second[0].Type)
	}
}
