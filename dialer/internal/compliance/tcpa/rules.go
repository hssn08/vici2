package tcpa

import "time"

// fedFloor is the unconditional federal baseline: 08:00–21:00 all days.
// 47 USC §227(b)(3); 47 CFR 64.1200(c)(1).
var fedFloor = Window{
	OpenLocal:  8 * time.Hour,
	CloseLocal: 21 * time.Hour,
	DowMask:    0, // all days
}

// intersect returns the most-restrictive (narrowest) combination of two windows.
// The resulting window's open is the *later* of the two opens, and its close
// is the *earlier* of the two closes.  If the result would be empty (open >= close),
// both are set equal (callers check IsBlackout / IsZero to detect this).
func intersect(a, b Window) Window {
	// If either is zero-value, return the other unchanged.
	if a.IsZero() {
		return b
	}
	if b.IsZero() {
		return a
	}
	open := a.OpenLocal
	if b.OpenLocal > open {
		open = b.OpenLocal
	}
	close := a.CloseLocal
	if b.CloseLocal < close {
		close = b.CloseLocal
	}
	return Window{
		OpenLocal:  open,
		CloseLocal: close,
		DowMask:    0,
	}
}

// ruleNameOf produces a stable human-readable rule identifier for audit.
func ruleNameOf(state string, dow int, eff Window) string {
	if state == "" {
		state = "FED"
	}
	dowNames := [7]string{"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"}
	openH := int(eff.OpenLocal.Hours())
	closeH := int(eff.CloseLocal.Hours())
	return state + "_" + dowNames[dow] + "_" + itoa(openH) + "_" + itoa(closeH)
}

// itoa is a minimal int-to-string without importing strconv (avoids import cycle).
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	buf := [3]byte{}
	pos := len(buf)
	for n > 0 {
		pos--
		buf[pos] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[pos:])
}

// midnightLocal returns the local midnight of the given time.
func midnightLocal(t time.Time) time.Time {
	y, m, d := t.Date()
	return time.Date(y, m, d, 0, 0, 0, 0, t.Location())
}

// stateFromTz maps unambiguous single-state IANA zones to their state code.
// Multi-state zones (e.g. America/New_York) return "" and the caller falls
// back to req.State (which may also be empty, meaning no state rule applies).
func stateFromTz(iana string) string {
	switch iana {
	case "America/Indiana/Indianapolis",
		"America/Indiana/Knox",
		"America/Indiana/Marengo",
		"America/Indiana/Petersburg",
		"America/Indiana/Tell_City",
		"America/Indiana/Vevay",
		"America/Indiana/Vincennes",
		"America/Indiana/Winamac":
		return "IN"
	case "America/Anchorage", "America/Juneau", "America/Nome",
		"America/Sitka", "America/Yakutat", "America/Metlakatla":
		return "AK"
	case "Pacific/Honolulu":
		return "HI"
	case "America/Adak":
		return "HI" // Aleutians use Hawaii zone but still AK
	case "Pacific/Pago_Pago":
		return "AS"
	case "Pacific/Guam":
		return "GU"
	case "America/Puerto_Rico":
		return "PR"
	case "Pacific/Saipan":
		return "MP"
	case "America/St_Thomas":
		return "VI"
	}
	// Multi-state zones or unknown → let caller use req.State.
	return ""
}
