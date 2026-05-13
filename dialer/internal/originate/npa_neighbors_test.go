package originate

import "testing"

func TestNeighborNPAs_knownOverlays(t *testing.T) {
	cases := []struct {
		npa      string
		mustHave []string
	}{
		{"212", []string{"646", "332"}},
		{"646", []string{"212", "332"}},
		{"404", []string{"678", "470"}},
		{"415", []string{"628"}},
		{"312", []string{"872"}},
	}
	for _, tc := range cases {
		got := neighborNPAs(tc.npa)
		gotSet := make(map[string]bool, len(got))
		for _, n := range got {
			gotSet[n] = true
		}
		for _, want := range tc.mustHave {
			if !gotSet[want] {
				t.Errorf("neighborNPAs(%q): missing %q in %v", tc.npa, want, got)
			}
		}
	}
}

func TestNeighborNPAs_unknownNPA_returnsEmpty(t *testing.T) {
	got := neighborNPAs("999")
	if len(got) != 0 {
		t.Errorf("neighborNPAs(\"999\") = %v; want empty", got)
	}
}

func TestNeighborNPAs_symmetry(t *testing.T) {
	// For each NPA A and each neighbor B, B should also list A as a neighbor.
	for npa, neighbors := range npaNeighbors {
		for _, nb := range neighbors {
			if nb == "" {
				continue
			}
			found := false
			for _, nbOfNb := range npaNeighbors[nb] {
				if nbOfNb == npa {
					found = true
					break
				}
			}
			if !found {
				t.Errorf("neighbor asymmetry: %s→%s exists but %s→%s does not", npa, nb, nb, npa)
			}
		}
	}
}
