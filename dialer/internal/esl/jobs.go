package esl

import (
	"sync"
	"time"
)

// jobResult is the parsed outcome of a BACKGROUND_JOB event.
type jobResult struct {
	Body    string // raw reply body from FS ("+OK <uuid>" or "-ERR ...")
	IsError bool   // true if body starts with "-ERR"
}

// jobDispatcher correlates bgapi Job-UUIDs to waiting callers.
// A caller registers a pending entry, then waits on its channel.
// The event handler delivers the result when BACKGROUND_JOB arrives.
type jobDispatcher struct {
	mu      sync.Mutex
	pending map[string]chan jobResult // jobUUID → result channel
}

func newJobDispatcher() *jobDispatcher {
	return &jobDispatcher{
		pending: make(map[string]chan jobResult),
	}
}

// register allocates a result channel for jobUUID. The caller must
// call await (or cancel) to avoid leaking the channel.
func (d *jobDispatcher) register(jobUUID string) chan jobResult {
	ch := make(chan jobResult, 1)
	d.mu.Lock()
	d.pending[jobUUID] = ch
	d.mu.Unlock()
	return ch
}

// deliver sends the result to the waiting caller (if any).
// Called from the event handler goroutine.
func (d *jobDispatcher) deliver(jobUUID string, result jobResult) {
	d.mu.Lock()
	ch, ok := d.pending[jobUUID]
	if ok {
		delete(d.pending, jobUUID)
	}
	d.mu.Unlock()

	if ok {
		select {
		case ch <- result:
		default:
		}
	}
}

// cancel removes the pending entry and closes the channel.
// Used by timeout cleanup.
func (d *jobDispatcher) cancel(jobUUID string) {
	d.mu.Lock()
	delete(d.pending, jobUUID)
	d.mu.Unlock()
}

// len returns the number of in-flight jobs.
func (d *jobDispatcher) len() int {
	d.mu.Lock()
	n := len(d.pending)
	d.mu.Unlock()
	return n
}

// await waits for the BACKGROUND_JOB result for jobUUID, with a deadline.
// It removes the pending entry on return (either success or timeout).
func (d *jobDispatcher) await(jobUUID string, ch chan jobResult, timeout time.Duration) (jobResult, error) {
	timer := time.NewTimer(timeout)
	defer timer.Stop()

	select {
	case r := <-ch:
		return r, nil
	case <-timer.C:
		d.cancel(jobUUID)
		return jobResult{}, ErrJobOrphaned
	}
}
