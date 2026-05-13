package dnc

import "github.com/prometheus/client_golang/prometheus"

func newTestRegistry() prometheus.Registerer {
	return prometheus.NewRegistry()
}
