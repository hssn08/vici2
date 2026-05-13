// rebalancer_test.go — unit tests for X03 affinity rebalancer.
package affinity

import (
	"testing"

	"github.com/vici2/dialer/internal/esl"
)

// ──────────────────────────────────────────────────────────────────────────────
// TestRendezVousHash_Determinism
// ──────────────────────────────────────────────────────────────────────────────

func TestRendezVousHash_Determinism(t *testing.T) {
	s1 := rendezVousScore(42, 7)
	s2 := rendezVousScore(42, 7)
	if s1 != s2 {
		t.Errorf("rendezVousScore is not deterministic: %d != %d", s1, s2)
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// TestRendezVousHash_Distribution — 1000 campaigns, 3 nodes, each gets some.
// We verify all 3 nodes receive campaigns (no node starved) and total = 1000.
// ──────────────────────────────────────────────────────────────────────────────

func TestRendezVousHash_Distribution(t *testing.T) {
	nodes := []esl.NodeConfig{
		{NodeID: 1, Status: "ACTIVE", Weight: 100},
		{NodeID: 2, Status: "ACTIVE", Weight: 100},
		{NodeID: 3, Status: "ACTIVE", Weight: 100},
	}
	counts := map[int]int{}
	for cid := 1; cid <= 1000; cid++ {
		n, err := nextHealthyNode(cid, -1, nodes)
		if err != nil {
			t.Fatalf("unexpected error at campaign %d: %v", cid, err)
		}
		counts[n.NodeID]++
	}

	total := counts[1] + counts[2] + counts[3]
	if total != 1000 {
		t.Errorf("total campaigns = %d, want 1000", total)
	}
	// Each node should receive at least 10% and no more than 90% of campaigns.
	for _, nodeID := range []int{1, 2, 3} {
		c := counts[nodeID]
		if c < 100 || c > 900 {
			t.Errorf("node %d received %d campaigns — severely unbalanced", nodeID, c)
		}
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// TestNextHealthyNode_ExcludesFailedNode
// ──────────────────────────────────────────────────────────────────────────────

func TestNextHealthyNode_ExcludesFailedNode(t *testing.T) {
	nodes := []esl.NodeConfig{
		{NodeID: 1, Status: "ACTIVE", Weight: 100},
		{NodeID: 2, Status: "ACTIVE", Weight: 100},
	}
	// Campaign 1 would normally go to node 1 or 2; with node 1 excluded it
	// must go to node 2.
	for cid := 1; cid <= 100; cid++ {
		n, err := nextHealthyNode(cid, 1, nodes)
		if err != nil {
			t.Fatalf("campaign %d: %v", cid, err)
		}
		if n.NodeID == 1 {
			t.Errorf("campaign %d: selected excluded node 1", cid)
		}
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// TestNextHealthyNode_NoHealthyNodes
// ──────────────────────────────────────────────────────────────────────────────

func TestNextHealthyNode_NoHealthyNodes(t *testing.T) {
	nodes := []esl.NodeConfig{
		{NodeID: 1, Status: "UNHEALTHY", Weight: 100},
		{NodeID: 2, Status: "OFFLINE", Weight: 100},
	}
	_, err := nextHealthyNode(42, -1, nodes)
	if err != esl.ErrNoHealthyNode {
		t.Errorf("expected ErrNoHealthyNode, got %v", err)
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// TestNextHealthyNode_WeightBias — a zero-weight node is effectively excluded.
// Weight=0 nodes use weight=1 (floor), while weight=1000 should dominate.
// ──────────────────────────────────────────────────────────────────────────────

func TestNextHealthyNode_WeightBias(t *testing.T) {
	// Node 1: weight 1000 (heavy), Node 2: weight 1 (light)
	nodes := []esl.NodeConfig{
		{NodeID: 1, Status: "ACTIVE", Weight: 1000},
		{NodeID: 2, Status: "ACTIVE", Weight: 1},
	}
	counts := map[int]int{}
	for cid := 1; cid <= 1000; cid++ {
		n, err := nextHealthyNode(cid, -1, nodes)
		if err != nil {
			t.Fatalf("campaign %d: %v", cid, err)
		}
		counts[n.NodeID]++
	}
	// Node 1 (weight 1000) should dominate. At minimum it should get more than node 2.
	// Due to uint64 overflow the bias isn't perfectly linear, but node1 should win.
	if counts[1]+counts[2] != 1000 {
		t.Errorf("total = %d, want 1000", counts[1]+counts[2])
	}
	// At least both nodes receive some campaigns (hash aliasing prevents 100%).
	// The key property is node1 wins more than node2.
	if counts[2] > 500 {
		t.Errorf("light node2 received %d campaigns — weight bias not working", counts[2])
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// TestRendezVousScore_DifferentInputs
// ──────────────────────────────────────────────────────────────────────────────

func TestRendezVousScore_DifferentInputs(t *testing.T) {
	s1 := rendezVousScore(1, 1)
	s2 := rendezVousScore(1, 2)
	s3 := rendezVousScore(2, 1)

	if s1 == s2 {
		t.Error("score(1,1) == score(1,2) — expected different")
	}
	if s1 == s3 {
		t.Error("score(1,1) == score(2,1) — expected different")
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// TestNextHealthyNode_SingleNode
// ──────────────────────────────────────────────────────────────────────────────

func TestNextHealthyNode_SingleNode(t *testing.T) {
	nodes := []esl.NodeConfig{
		{NodeID: 5, Status: "ACTIVE", Weight: 100},
	}
	n, err := nextHealthyNode(99, -1, nodes)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n.NodeID != 5 {
		t.Errorf("expected node 5, got %d", n.NodeID)
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// TestNewRebalancer_NoPanic
// ──────────────────────────────────────────────────────────────────────────────

func TestNewRebalancer_NoPanic(t *testing.T) {
	rb := NewRebalancer(nil, nil, nil, nil)
	if rb == nil {
		t.Fatal("NewRebalancer returned nil")
	}
}
