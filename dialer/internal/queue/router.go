package queue

import (
	"sort"
)

// PickAgent selects the best agent for the given call using the in-group's
// routing strategy. candidates must already be skill-filtered (MatchScore >= 0).
// Returns nil if no suitable agent found.
// I01 PLAN §5.1–§5.3 (FROZEN).
func PickAgent(call *QueuedCall, ig *InGroup, candidates []*Agent) *Agent {
	if len(candidates) == 0 {
		return nil
	}

	switch ig.RoutingStrategy {
	case StrategySkillPriority:
		return pickSkillPriority(call, ig, candidates)
	case StrategyLongestIdle:
		return pickLongestIdle(candidates)
	case StrategyRoundRobin:
		return pickRoundRobin(candidates)
	case StrategyTopDown:
		return pickTopDown(candidates)
	case StrategyFewestCalls:
		return pickFewestCalls(candidates)
	default:
		// Fallback to skill_priority for unknown strategies.
		return pickSkillPriority(call, ig, candidates)
	}
}

// pickSkillPriority selects agent with highest MatchScore.
// Ties broken by longest idle (lowest LastReadyChangeTs).
// I01 PLAN §5.1.
func pickSkillPriority(call *QueuedCall, ig *InGroup, candidates []*Agent) *Agent {
	sort.SliceStable(candidates, func(i, j int) bool {
		si := candidates[i].Skills.MatchScore(ig.SkillRequirements)
		sj := candidates[j].Skills.MatchScore(ig.SkillRequirements)
		if si != sj {
			return si > sj // higher score = better
		}
		// Tie-break: lower LastReadyChangeTs = idle longer = dispatched first
		return candidates[i].LastReadyChangeTs < candidates[j].LastReadyChangeTs
	})
	_ = call // call data may be used for sticky in higher-level logic
	return candidates[0]
}

// pickLongestIdle selects agent with smallest LastReadyChangeTs (longest idle).
// I01 PLAN §5.1.
func pickLongestIdle(candidates []*Agent) *Agent {
	best := candidates[0]
	for _, a := range candidates[1:] {
		if a.LastReadyChangeTs < best.LastReadyChangeTs {
			best = a
		}
	}
	return best
}

// pickRoundRobin selects the agent with the oldest LastDispatchedAt.
// I01 PLAN §5.1.
func pickRoundRobin(candidates []*Agent) *Agent {
	best := candidates[0]
	for _, a := range candidates[1:] {
		if a.LastDispatchedAt < best.LastDispatchedAt {
			best = a
		}
	}
	return best
}

// pickTopDown selects by ascending Rank, then longest idle.
// I01 PLAN §5.1.
func pickTopDown(candidates []*Agent) *Agent {
	sort.SliceStable(candidates, func(i, j int) bool {
		if candidates[i].Rank != candidates[j].Rank {
			return candidates[i].Rank < candidates[j].Rank // lower rank = higher priority
		}
		return candidates[i].LastReadyChangeTs < candidates[j].LastReadyChangeTs
	})
	return candidates[0]
}

// pickFewestCalls selects agent with lowest CallsHandledToday.
// Ties broken by longest idle.
// I01 PLAN §5.1.
func pickFewestCalls(candidates []*Agent) *Agent {
	sort.SliceStable(candidates, func(i, j int) bool {
		if candidates[i].CallsHandledToday != candidates[j].CallsHandledToday {
			return candidates[i].CallsHandledToday < candidates[j].CallsHandledToday
		}
		return candidates[i].LastReadyChangeTs < candidates[j].LastReadyChangeTs
	})
	return candidates[0]
}
