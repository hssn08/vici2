package esl

import (
	"context"
	"fmt"
)

// UUIDRecord starts, stops, masks, or unmasks recording on a channel.
// action: "start" | "stop" | "mask" | "unmask"
// path: absolute filesystem path on the FS host (R01 builds the path per F03 §6)
//
// T01 PLAN §8.
func (c *Client) UUIDRecord(ctx context.Context, fsHost, callUUID, action, path string) error {
	cmd := fmt.Sprintf("uuid_record %s %s %s", callUUID, action, path)
	return c.runUUIDCmd(ctx, fsHost, "UUIDRecord", cmd)
}
