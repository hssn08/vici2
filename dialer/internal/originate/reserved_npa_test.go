package originate

import "testing"

func TestIsReservedNPA(t *testing.T) {
	reserved := []string{
		"800", "833", "844", "855", "866", "877", "888", // toll-free
		"900",                                           // premium-rate
		"555",                                           // fictitious
		"976",                                           // pay-per-call
		"500", "521", "522", "524", "533", "544", "566", "577", "588", // PCS
	}
	for _, npa := range reserved {
		if !isReservedNPA(npa) {
			t.Errorf("isReservedNPA(%q) = false; want true", npa)
		}
	}

	geographic := []string{"212", "415", "713", "312", "404", "617", "206"}
	for _, npa := range geographic {
		if isReservedNPA(npa) {
			t.Errorf("isReservedNPA(%q) = true; want false", npa)
		}
	}
}

func TestExtractNPA(t *testing.T) {
	cases := []struct {
		e164 string
		want string
	}{
		{"+14155551234", "415"},
		{"+12125559999", "212"},
		{"+17138881234", "713"},
		{"+18005551234", "800"},
		{"+15555551234", "555"},
		{"", ""},
		{"4155551234", ""},       // no +
		{"+44207946000", ""},     // UK, not NANP
		{"+1415", ""},            // too short
	}
	for _, tc := range cases {
		got := extractNPA(tc.e164)
		if got != tc.want {
			t.Errorf("extractNPA(%q) = %q; want %q", tc.e164, got, tc.want)
		}
	}
}
