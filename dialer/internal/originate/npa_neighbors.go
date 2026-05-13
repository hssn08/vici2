package originate

// npaNeighbors maps each NPA to its overlay and geographically adjacent NPAs.
// Covers the 30 highest-volume US metro overlay zones as of 2026-Q1.
// Source: NANPA overlay assignments (nanpa.com/area-codes/overlay-area-codes).
//
// Phase-2 will move this to an admin-editable Valkey HASH for hot updates.
// Until then, a redeployment is required to add new NANPA overlays.
var npaNeighbors = map[string][]string{
	// New York City — Manhattan
	"212": {"646", "332"},
	"646": {"212", "332"},
	"332": {"212", "646"},
	// New York City — outer boroughs
	"718": {"347", "929"},
	"347": {"718", "929"},
	"929": {"718", "347"},

	// Los Angeles basin
	"213": {"323", "747"},
	"310": {"424"},
	"323": {"213", "747"},
	"424": {"310"},
	"747": {"818", "213", "323"},
	"818": {"747", "626"},
	"626": {"818"},
	"562": {"657"},
	"657": {"562"},

	// Atlanta, GA
	"404": {"678", "470"},
	"678": {"404", "470"},
	"470": {"404", "678"},

	// Chicago, IL
	"312": {"872"},
	"773": {"872"},
	"872": {"312", "773"},

	// Houston, TX
	"713": {"832", "281", "346"},
	"832": {"713", "281", "346"},
	"281": {"713", "832", "346"},
	"346": {"713", "832", "281"},

	// Dallas / Fort Worth, TX
	"214": {"469", "972", "945"},
	"469": {"214", "972", "945"},
	"972": {"214", "469", "945"},
	"945": {"214", "469", "972"},

	// San Francisco Bay Area
	"415": {"628"},
	"628": {"415"},
	"408": {"669"},
	"669": {"408"},
	"510": {"341"},
	"341": {"510"},

	// Phoenix, AZ
	"480": {"623", "602"},
	"602": {"480", "623"},
	"623": {"480", "602"},

	// Miami, FL
	"305": {"786"},
	"786": {"305"},

	// Philadelphia, PA
	"215": {"267", "445"},
	"267": {"215", "445"},
	"445": {"215", "267"},

	// Washington DC metro
	"301": {"240"},
	"240": {"301"},
	"703": {"571"},
	"571": {"703"},

	// Seattle, WA
	"206": {"564"},
	"564": {"206", "253"},
	"253": {"564"},

	// Denver, CO
	"303": {"720"},
	"720": {"303"},

	// Boston, MA
	"617": {"857"},
	"857": {"617"},

	// San Diego, CA
	"619": {"858"},
	"858": {"619"},

	// Minneapolis, MN
	"612": {"952", "763", "651"},
	"952": {"612"},
	"763": {"612"},
	"651": {"612"},

	// Portland, OR
	"503": {"971"},
	"971": {"503"},

	// Las Vegas, NV
	"702": {"725"},
	"725": {"702"},
}

// neighborNPAs returns the list of overlay / adjacent NPAs for the given NPA.
// Returns nil (empty slice) when no neighbors are known.
func neighborNPAs(npa string) []string {
	return npaNeighbors[npa]
}
