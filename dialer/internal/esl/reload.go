package esl

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// Reload triggers an FS reload of the named subsystem.
// what examples: "xml", "acl", "mod_event_socket",
//
//	"sofia profile external rescan", "sofia profile external restart"
//
// Used by T02 (carrier mgmt) when re-rendering external gateway XMLs.
// T01 PLAN §8.
func (c *Client) Reload(ctx context.Context, fsHost, what string) error {
	if c.isShuttingDown() {
		return ErrShuttingDown
	}
	conn, _, err := c.getConn(fsHost)
	if err != nil {
		return err
	}

	start := time.Now()

	// Reload commands use synchronous api (not bgapi) since they're
	// one-shot management operations.
	cmd := buildReloadCmd(what)
	resp, err := conn.SendCommand(ctx, &rawAPICommand{cmd: cmd})
	latency := time.Since(start)

	outcome := "ok"
	if err != nil || (resp != nil && strings.HasPrefix(resp.GetReply(), "-ERR")) {
		outcome = "error"
		c.metrics.commandTotal.WithLabelValues(fsHost, "reload", outcome).Inc()
		c.metrics.commandLatency.WithLabelValues(fsHost, "reload").Observe(latency.Seconds())
		if err != nil {
			return fmt.Errorf("esl Reload: %w", err)
		}
		return fmt.Errorf("esl Reload: fs error: %s", resp.GetReply())
	}

	c.metrics.commandTotal.WithLabelValues(fsHost, "reload", outcome).Inc()
	c.metrics.commandLatency.WithLabelValues(fsHost, "reload").Observe(latency.Seconds())
	return nil
}

// buildReloadCmd maps the human-readable `what` to the FS API command string.
func buildReloadCmd(what string) string {
	switch {
	case what == "xml":
		return "reloadxml"
	case what == "acl":
		return "reloadacl"
	case what == "mod_event_socket":
		return "reload mod_event_socket"
	case strings.HasPrefix(what, "sofia profile"):
		return what // pass through as-is: "sofia profile external rescan"
	default:
		return what
	}
}

// rawAPICommand sends a raw api command string via eslgo.
type rawAPICommand struct{ cmd string }

func (r *rawAPICommand) BuildMessage() string {
	return "api " + r.cmd
}
