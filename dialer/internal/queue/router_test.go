package queue

import (
	"testing"
	"time"
)

// TestMatchScore covers all 10 table-driven fixtures from I01 PLAN §4.3.
func TestMatchScore(t *testing.T) {
	cases := []struct {
		name     string
		reqs     []SkillRequirement
		skills   map[string]int
		wantNil  bool
		wantMin  int // if not nil, result >= wantMin
		wantExact int // if > 0, result == wantExact
	}{
		{
			name: "single required skill match",
			reqs: []SkillRequirement{
				{SkillKey: "language", SkillValue: "es", MinProficiency: 5, Required: true, Weight: 100},
			},
			skills:     map[string]int{"language:es": 8},
			wantExact: 400, // (8-5+1)*100
		},
		{
			name: "two required skills both match",
			reqs: []SkillRequirement{
				{SkillKey: "language", SkillValue: "es", MinProficiency: 5, Required: true, Weight: 100},
				{SkillKey: "product", SkillValue: "billing", MinProficiency: 3, Required: true, Weight: 80},
			},
			skills: map[string]int{
				"language:es":      8,
				"product:billing":  5,
			},
			wantExact: 640, // (8-5+1)*100 + (5-3+1)*80 = 400 + 240
		},
		{
			name: "two required, agent missing second",
			reqs: []SkillRequirement{
				{SkillKey: "language", SkillValue: "es", MinProficiency: 5, Required: true, Weight: 100},
				{SkillKey: "product", SkillValue: "billing", MinProficiency: 3, Required: true, Weight: 80},
			},
			skills: map[string]int{
				"language:es":   9,
				"product:tech":  7,
			},
			wantNil: true, // billing gated
		},
		{
			name: "optional skill matched",
			reqs: []SkillRequirement{
				{SkillKey: "cert", SkillValue: "PCI", MinProficiency: 1, Required: false, Weight: 20},
			},
			skills:    map[string]int{"cert:PCI": 3},
			wantExact: 60, // (3-1+1)*20
		},
		{
			name: "optional skill not held — still eligible score 0",
			reqs: []SkillRequirement{
				{SkillKey: "cert", SkillValue: "PCI", MinProficiency: 1, Required: false, Weight: 20},
			},
			skills:    map[string]int{},
			wantExact: 0, // no cert, not gated (required=false)
		},
		{
			name: "no requirements — all agents eligible",
			reqs:      []SkillRequirement{},
			skills:    map[string]int{"language:es": 5},
			wantExact: 0,
		},
		{
			name: "exactly at minimum proficiency — passes gate",
			reqs: []SkillRequirement{
				{SkillKey: "language", SkillValue: "es", MinProficiency: 5, Required: true, Weight: 100},
			},
			skills:    map[string]int{"language:es": 5},
			wantExact: 100, // (5-5+1)*100 = 100
		},
		{
			name: "one below minimum — gated",
			reqs: []SkillRequirement{
				{SkillKey: "language", SkillValue: "es", MinProficiency: 5, Required: true, Weight: 100},
			},
			skills:  map[string]int{"language:es": 4},
			wantNil: true,
		},
		{
			name: "required + optional both match",
			reqs: []SkillRequirement{
				{SkillKey: "lang", SkillValue: "es", MinProficiency: 5, Required: true, Weight: 100},
				{SkillKey: "lang", SkillValue: "fr", MinProficiency: 3, Required: false, Weight: 50},
			},
			skills: map[string]int{
				"lang:es": 7,
				"lang:fr": 4,
			},
			wantExact: 400, // (7-5+1)*100 + (4-3+1)*50 = 300+100
		},
		{
			name: "two required, agent has only first",
			reqs: []SkillRequirement{
				{SkillKey: "language", SkillValue: "es", MinProficiency: 5, Required: true, Weight: 100},
				{SkillKey: "product", SkillValue: "billing", MinProficiency: 2, Required: true, Weight: 80},
			},
			skills:  map[string]int{"language:es": 8},
			wantNil: true, // billing gated (prof=0 < min=2)
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ss := &AgentSkillSet{Skills: tc.skills, LoadedAt: time.Now()}
			got := ss.MatchScore(tc.reqs)
			if tc.wantNil {
				if got != -1 {
					t.Errorf("expected nil (−1), got %d", got)
				}
				return
			}
			if tc.wantExact > 0 || (tc.wantExact == 0 && !tc.wantNil) {
				if got != tc.wantExact {
					t.Errorf("want score %d, got %d", tc.wantExact, got)
				}
			}
			if tc.wantMin > 0 && got < tc.wantMin {
				t.Errorf("want score >= %d, got %d", tc.wantMin, got)
			}
		})
	}
}

// TestPickAgent_SkillPriority verifies skill_priority algorithm.
func TestPickAgent_SkillPriority(t *testing.T) {
	ig := &InGroup{
		ID:              "TEST",
		RoutingStrategy: StrategySkillPriority,
		SkillRequirements: []SkillRequirement{
			{SkillKey: "language", SkillValue: "es", MinProficiency: 1, Required: false, Weight: 100},
		},
	}
	call := &QueuedCall{CallUUID: "test-uuid"}

	agentA := &Agent{
		UserID:            1,
		LastReadyChangeTs: 1000,
		Skills:            AgentSkillSet{Skills: map[string]int{"language:es": 3}},
	}
	agentB := &Agent{
		UserID:            2,
		LastReadyChangeTs: 2000,
		Skills:            AgentSkillSet{Skills: map[string]int{"language:es": 8}},
	}

	picked := PickAgent(call, ig, []*Agent{agentA, agentB})
	if picked == nil {
		t.Fatal("expected agent, got nil")
	}
	if picked.UserID != 2 {
		t.Errorf("expected agent 2 (higher skill score), got %d", picked.UserID)
	}
}

// TestPickAgent_LongestIdle verifies longest_idle algorithm.
func TestPickAgent_LongestIdle(t *testing.T) {
	ig := &InGroup{ID: "TEST", RoutingStrategy: StrategyLongestIdle}
	call := &QueuedCall{CallUUID: "test-uuid"}

	agents := []*Agent{
		{UserID: 1, LastReadyChangeTs: 5000},
		{UserID: 2, LastReadyChangeTs: 1000}, // idle longest
		{UserID: 3, LastReadyChangeTs: 3000},
	}

	picked := PickAgent(call, ig, agents)
	if picked.UserID != 2 {
		t.Errorf("expected agent 2 (longest idle), got %d", picked.UserID)
	}
}

// TestPickAgent_RoundRobin verifies round_robin algorithm.
func TestPickAgent_RoundRobin(t *testing.T) {
	ig := &InGroup{ID: "TEST", RoutingStrategy: StrategyRoundRobin}
	call := &QueuedCall{CallUUID: "test-uuid"}

	agents := []*Agent{
		{UserID: 1, LastDispatchedAt: 500},
		{UserID: 2, LastDispatchedAt: 100}, // dispatched longest ago
		{UserID: 3, LastDispatchedAt: 300},
	}

	picked := PickAgent(call, ig, agents)
	if picked.UserID != 2 {
		t.Errorf("expected agent 2 (lowest last_dispatched_at), got %d", picked.UserID)
	}
}

// TestPickAgent_TopDown verifies top_down algorithm.
func TestPickAgent_TopDown(t *testing.T) {
	ig := &InGroup{ID: "TEST", RoutingStrategy: StrategyTopDown}
	call := &QueuedCall{CallUUID: "test-uuid"}

	agents := []*Agent{
		{UserID: 1, Rank: 3, LastReadyChangeTs: 1000},
		{UserID: 2, Rank: 1, LastReadyChangeTs: 2000}, // lowest rank = highest priority
		{UserID: 3, Rank: 2, LastReadyChangeTs: 1500},
	}

	picked := PickAgent(call, ig, agents)
	if picked.UserID != 2 {
		t.Errorf("expected agent 2 (rank=1), got %d", picked.UserID)
	}
}

// TestPickAgent_FewestCalls verifies fewest_calls algorithm.
func TestPickAgent_FewestCalls(t *testing.T) {
	ig := &InGroup{ID: "TEST", RoutingStrategy: StrategyFewestCalls}
	call := &QueuedCall{CallUUID: "test-uuid"}

	agents := []*Agent{
		{UserID: 1, CallsHandledToday: 10},
		{UserID: 2, CallsHandledToday: 2}, // fewest calls
		{UserID: 3, CallsHandledToday: 7},
	}

	picked := PickAgent(call, ig, agents)
	if picked.UserID != 2 {
		t.Errorf("expected agent 2 (fewest calls), got %d", picked.UserID)
	}
}

// TestPickAgent_EmptyCandidates verifies nil is returned when no eligible agents.
func TestPickAgent_EmptyCandidates(t *testing.T) {
	ig := &InGroup{ID: "TEST", RoutingStrategy: StrategySkillPriority}
	call := &QueuedCall{CallUUID: "test-uuid"}

	picked := PickAgent(call, ig, nil)
	if picked != nil {
		t.Errorf("expected nil for empty candidates, got agent %d", picked.UserID)
	}
}

// TestPickAgent_TiebreakByIdle verifies that equal-score agents fall back to longest idle.
func TestPickAgent_TiebreakByIdle(t *testing.T) {
	ig := &InGroup{
		ID:              "TEST",
		RoutingStrategy: StrategySkillPriority,
		SkillRequirements: []SkillRequirement{
			{SkillKey: "language", SkillValue: "es", MinProficiency: 1, Required: false, Weight: 100},
		},
	}
	call := &QueuedCall{CallUUID: "test-uuid"}

	// Both agents have same MatchScore
	agentA := &Agent{
		UserID:            1,
		LastReadyChangeTs: 5000,
		Skills:            AgentSkillSet{Skills: map[string]int{"language:es": 5}},
	}
	agentB := &Agent{
		UserID:            2,
		LastReadyChangeTs: 1000, // idle longer
		Skills:            AgentSkillSet{Skills: map[string]int{"language:es": 5}},
	}

	picked := PickAgent(call, ig, []*Agent{agentA, agentB})
	if picked.UserID != 2 {
		t.Errorf("expected agent 2 (tie-break: longer idle), got %d", picked.UserID)
	}
}
