// export_test.go exposes internal functions for black-box tests in package tcpa_test.
package tcpa

// IntersectForTest exposes intersect for property-based tests.
func IntersectForTest(a, b Window) Window {
	return intersect(a, b)
}

// NoopSinkForTest returns a Sink that discards all rows.
func NoopSinkForTest() Sink {
	return noopSink{}
}
