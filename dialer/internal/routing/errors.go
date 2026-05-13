package routing

import "errors"

// Sentinel errors returned by routing functions.
// T02 PLAN §4 error taxonomy.
var (
	// ErrNoGateway is returned when SelectGateway finds no eligible gateway
	// (all are unhealthy, inactive, or at capacity).
	ErrNoGateway = errors.New("routing: no eligible gateway available")

	// ErrGatewayAtCapacity is returned when a single candidate gateway is at
	// its max_concurrent limit. T02 PLAN §10.2.
	ErrGatewayAtCapacity = errors.New("routing: gateway at max_concurrent capacity")

	// ErrCarrierAtCapacity is returned when the carrier-wide max_concurrent
	// aggregate is exceeded. T02 PLAN §10.2.
	ErrCarrierAtCapacity = errors.New("routing: carrier at max_concurrent capacity")

	// ErrInvalidKind is returned when a carrier Kind fails validation.
	ErrInvalidKind = errors.New("routing: invalid carrier kind")

	// ErrEmptyGatewayName is returned when a Gateway.Name is empty.
	ErrEmptyGatewayName = errors.New("routing: gateway name is empty")
)
