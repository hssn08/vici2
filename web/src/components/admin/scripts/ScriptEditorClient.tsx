"use client";

// M07 — Client wrapper for the script editor page.
// Handles the loading boundary and passes props down to ScriptEditor.

import * as React from "react";
import { ScriptEditor } from "./ScriptEditor";

interface ScriptEditorClientProps {
  mode: "create" | "edit";
  scriptId?: string;
}

export function ScriptEditorClient({ mode, scriptId }: ScriptEditorClientProps): React.ReactElement {
  return <ScriptEditor mode={mode} scriptId={scriptId} />;
}
