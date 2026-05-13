package esl

import (
	"context"
	"fmt"

	"github.com/percipia/eslgo/command"
)

// ShowChannelUUIDs returns the set of live channel UUIDs from one FS host.
// Uses `show channels as json`. Returns an empty map (not nil) on success
// with zero channels.
// E06 PLAN §3.2 Step 2.
func (c *Client) ShowChannelUUIDs(ctx context.Context, fsHost string) (map[string]bool, error) {
	if c.isShuttingDown() {
		return nil, ErrShuttingDown
	}
	conn, _, err := c.getConn(fsHost)
	if err != nil {
		return nil, fmt.Errorf("esl ShowChannelUUIDs: %w", err)
	}
	resp, err := conn.SendCommand(ctx, command.API{
		Command:    "show",
		Arguments:  "channels as json",
		Background: false,
	})
	if err != nil {
		return nil, fmt.Errorf("esl ShowChannelUUIDs: %w", err)
	}
	return parseShowChannelsJSON(resp.Body), nil
}
