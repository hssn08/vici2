"use client";

/**
 * AgentStateToggle — A09: thin wrapper around PauseButton for backward compatibility.
 * @deprecated Use <PauseButton /> directly.
 */

import * as React from "react";
import { PauseButton } from "./PauseButton";

export function AgentStateToggle(): React.ReactElement {
  return <PauseButton />;
}
