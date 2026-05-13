// I02 — FreeSWITCH dialplan XML builder.
//
// Generates:
//   - 70_ivr_{id}.xml  (default context: node extensions)
//   - 10_did_{e164}.xml (public context: DID entry point)
//
// PLAN §7.4, §4.1–§4.5, §6

import type { IvrNodeType } from "@vici2/types";
import { TERMINAL_NODE_TYPES } from "@vici2/types";

export interface PromptVariant {
  lang: string;
  localPath: string; // absolute path on FS container
}

export interface BuilderNode {
  id: bigint;
  nodeType: IvrNodeType;
  name: string;
  collectMin: number;
  collectMax: number;
  collectTerminators: string;
  timeoutMs: number;
  invalidMax: number;
  actionTarget: string | null;
  prompts: PromptVariant[];
}

export interface BuilderEdge {
  fromNodeId: bigint;
  onInput: string;
  toNodeId: bigint | null;
  label: string | null;
  sortOrder: number;
}

export interface BuilderIvr {
  id: bigint;
  entryNodeId: bigint;
  nodes: BuilderNode[];
  edges: BuilderEdge[];
}

export interface BuilderDid {
  e164: string;
  e164Digits: string; // strip leading +
  defaultLang: string;
  ivrTimeoutSec: number;
  ivrId: bigint;
  recordingDisclosureAudio: string | null;
}

// Sound file base path on FS container
const FS_IVR_SYS = "/var/lib/freeswitch/sounds/ivr/sys";

function escXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function nodeExtName(ivrId: bigint, nodeId: bigint): string {
  return `ivr_${ivrId}_n${nodeId}`;
}

function promptConditions(
  ivrId: bigint,
  node: BuilderNode,
): string {
  const tenantPart = `t${1}`; // Phase 1: single-tenant path placeholder
  void tenantPart;
  if (node.prompts.length === 0) {
    // Fallback to system silence
    return `    <action application="playback" data="${FS_IVR_SYS}/sys_invalid.wav"/>\n`;
  }

  const enPrompt = node.prompts.find((p) => p.lang === "en");
  const nonEnPrompts = node.prompts.filter((p) => p.lang !== "en");

  let xml = "";

  // Non-English language conditions first
  for (const p of nonEnPrompts) {
    xml += `    <condition field="\${vici2_ivr_lang}" expression="^${escXml(p.lang)}$" break="on-true">\n`;
    xml += `      <action application="playback" data="${escXml(p.localPath)}"/>\n`;
    xml += `    </condition>\n`;
  }

  // English (or fallback) — the last condition catches anything else
  const fallbackPath = enPrompt
    ? enPrompt.localPath
    : `${FS_IVR_SYS}/sys_invalid.wav`;

  if (nonEnPrompts.length > 0) {
    // Catch-all fallback for any other lang value
    xml += `    <condition field="\${vici2_ivr_lang}" expression="^.*$" break="on-true">\n`;
    xml += `      <action application="playback" data="${escXml(fallbackPath)}"/>\n`;
    xml += `    </condition>\n`;
  } else {
    xml += `    <action application="playback" data="${escXml(fallbackPath)}"/>\n`;
  }

  return xml;
}

function buildCollectExtension(ivrId: bigint, node: BuilderNode): string {
  const extName = nodeExtName(ivrId, node.id);
  const terminators =
    node.collectTerminators === "none" ? "none" : node.collectTerminators;

  return `
  <!-- === Node ${node.id}: ${escXml(node.name)} (${node.nodeType}) === -->
  <extension name="${extName}" continue="false">
    <condition field="destination_number" expression="^${extName}$">
      <action application="set" data="vici2_ivr_node_id=${node.id}"/>
      <action application="set" data="vici2_ivr_path=\${vici2_ivr_path}:${node.id}"/>
${promptConditions(ivrId, node)}      <action application="read" data="${node.collectMin} ${node.collectMax} '' ivr_digit_${node.id} ${node.timeoutMs} ${terminators}"/>
      <action application="execute_extension" data="${extName}_branch XML default"/>
    </condition>
  </extension>
`;
}

function buildBranchExtension(
  ivrId: bigint,
  node: BuilderNode,
  edges: BuilderEdge[],
): string {
  const extName = nodeExtName(ivrId, node.id);
  const sorted = [...edges].sort((a, b) => a.sortOrder - b.sortOrder);

  let xml = `
  <!-- === Branch dispatcher for node ${node.id} === -->
  <extension name="${extName}_branch" continue="false">
`;

  for (const edge of sorted) {
    if (edge.onInput === "__TIMEOUT__") continue; // handled below
    if (edge.onInput === "__INVALID_MAX__") continue; // handled in invalid_check

    const target = edge.toNodeId
      ? nodeExtName(ivrId, edge.toNodeId)
      : `ivr_${ivrId}_n${node.id}`; // self-loop fallback (shouldn't happen)

    xml += `    <condition field="\${ivr_digit_${node.id}}" expression="^${escXml(edge.onInput)}$" break="on-true">\n`;
    xml += `      <action application="set" data="vici2_ivr_digits=\${vici2_ivr_digits}:${escXml(edge.onInput)}"/>\n`;

    if (node.nodeType === "lang_select") {
      // lang_select: set language channel var before transfer
      xml += `      <action application="set" data="vici2_ivr_lang=${escXml(edge.onInput === "1" ? "en" : "es")}"/>\n`;
    }

    xml += `      <action application="transfer" data="${target} XML default"/>\n`;
    xml += `    </condition>\n`;
  }

  // Timeout edge (empty read result)
  const timeoutEdge = sorted.find((e) => e.onInput === "__TIMEOUT__");
  if (timeoutEdge && timeoutEdge.toNodeId) {
    xml += `    <condition field="\${ivr_digit_${node.id}}" expression="^$" break="on-true">\n`;
    xml += `      <action application="transfer" data="${nodeExtName(ivrId, timeoutEdge.toNodeId)} XML default"/>\n`;
    xml += `    </condition>\n`;
  }

  // Invalid input — increment counter, check max
  xml += `    <condition field="\${ivr_digit_${node.id}}" expression="^.*$" break="on-true">\n`;
  xml += `      <action application="set" data="ivr_invalid_count=\${expr(\${ivr_invalid_count}+1)}"/>\n`;
  xml += `      <action application="execute_extension" data="${extName}_invalid_check XML default"/>\n`;
  xml += `    </condition>\n`;

  xml += `  </extension>\n`;
  return xml;
}

function buildInvalidCheckExtension(
  ivrId: bigint,
  node: BuilderNode,
  edges: BuilderEdge[],
): string {
  const extName = nodeExtName(ivrId, node.id);
  const invalidMaxEdge = edges.find((e) => e.onInput === "__INVALID_MAX__");
  const maxTarget = invalidMaxEdge?.toNodeId
    ? nodeExtName(ivrId, invalidMaxEdge.toNodeId)
    : `${FS_IVR_SYS}/sys_goodbye.wav`; // last-resort

  // Match: invalid_max or higher (as a regex)
  const m = node.invalidMax;

  const xml = `
  <!-- === Invalid count check for node ${node.id} === -->
  <extension name="${extName}_invalid_check" continue="false">
    <condition field="\${ivr_invalid_count}" expression="^([${m}-9]|[1-9][0-9]+)$" break="on-true">
      <action application="set" data="ivr_invalid_count=0"/>
      <action application="transfer" data="${maxTarget} XML default"/>
    </condition>
    <condition field="\${ivr_invalid_count}" expression="^.*$" break="on-true">
      <action application="transfer" data="${extName} XML default"/>
    </condition>
  </extension>
`;
  return xml;
}

function buildTerminalExtension(
  ivrId: bigint,
  node: BuilderNode,
): string {
  const extName = nodeExtName(ivrId, node.id);
  let actions = "";

  switch (node.nodeType) {
    case "terminal_ingroup":
      actions += `      <action application="set" data="vici2_ivr_exit_node=${node.id}"/>\n`;
      actions += `      <action application="set" data="vici2_ivr_exit_action=route_to_ingroup"/>\n`;
      actions += `      <action application="set" data="vici2_ivr_exit_target=${escXml(node.actionTarget ?? "")}"/>\n`;
      actions += `      <action application="transfer" data="ingroup_${escXml(node.actionTarget ?? "")} XML default"/>\n`;
      break;

    case "terminal_hangup":
      actions += `      <action application="playback" data="${node.actionTarget ? escXml(node.actionTarget) : `${FS_IVR_SYS}/sys_goodbye.wav`}"/>\n`;
      actions += `      <action application="hangup" data="NORMAL_CLEARING"/>\n`;
      break;

    case "terminal_voicemail":
      actions += `      <action application="transfer" data="voicemail_${escXml(node.actionTarget ?? "")} XML default"/>\n`;
      break;

    case "terminal_transfer":
      actions += `      <action application="set" data="hangup_after_bridge=true"/>\n`;
      actions += `      <action application="bridge" data="sofia/gateway/\${default_gateway}/${escXml(node.actionTarget ?? "")}"/>\n`;
      break;

    case "terminal_callback":
      actions += `      <action application="play_and_get_digits" data="1 1 1 8000 # ${FS_IVR_SYS}/sys_callback_offer.wav ${FS_IVR_SYS}/sys_invalid.wav VICI2_CB_OPT \\d 1000 ^1$"/>\n`;
      actions += `      <action application="execute_extension" data="ivr_callback_dispatch_${node.id} XML default"/>\n`;
      break;

    default:
      actions += `      <action application="hangup" data="NORMAL_CLEARING"/>\n`;
  }

  return `
  <!-- === Terminal node ${node.id}: ${escXml(node.name)} (${node.nodeType}) === -->
  <extension name="${extName}" continue="false">
    <condition field="destination_number" expression="^${extName}$">
      <action application="set" data="vici2_ivr_node_id=${node.id}"/>
      <action application="set" data="vici2_ivr_path=\${vici2_ivr_path}:${node.id}"/>
${actions}    </condition>
  </extension>
`;
}

function buildCallbackDispatchExtension(
  node: BuilderNode,
): string {
  const ingroup = node.actionTarget ?? "";
  return `
  <!-- === Callback dispatch for node ${node.id} === -->
  <extension name="ivr_callback_dispatch_${node.id}" continue="false">
    <condition field="\${VICI2_CB_OPT}" expression="^1$" break="on-true">
      <action application="set" data="vici2_callback_ingroup=${escXml(ingroup)}"/>
      <action application="api" data="bgapi uuid_broadcast \${uuid} execute::curl http://api:3000/internal/ivr/callback_accept/\${uuid}"/>
      <action application="playback" data="${FS_IVR_SYS}/sys_callback_confirmed.wav"/>
      <action application="hangup" data="NORMAL_CLEARING"/>
    </condition>
    <condition field="\${VICI2_CB_OPT}" expression="^.*$" break="on-true">
      <action application="transfer" data="ingroup_${escXml(ingroup)} XML default"/>
    </condition>
  </extension>
`;
}

/** Generate 70_ivr_{id}.xml — default context with all node extensions */
export function buildDefaultContextXml(ivr: BuilderIvr): string {
  const adjacency = new Map<bigint, BuilderEdge[]>();
  for (const n of ivr.nodes) {
    adjacency.set(n.id, []);
  }
  for (const e of ivr.edges) {
    adjacency.get(e.fromNodeId)?.push(e);
  }

  let extensions = "";

  for (const node of ivr.nodes) {
    const nodeEdges = adjacency.get(node.id) ?? [];
    const isTerminal = TERMINAL_NODE_TYPES.has(node.nodeType);

    if (isTerminal) {
      extensions += buildTerminalExtension(ivr.id, node);
      if (node.nodeType === "terminal_callback") {
        extensions += buildCallbackDispatchExtension(node);
      }
    } else {
      extensions += buildCollectExtension(ivr.id, node);
      extensions += buildBranchExtension(ivr.id, node, nodeEdges);
      extensions += buildInvalidCheckExtension(ivr.id, node, nodeEdges);
    }
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generated by I02 IvrRenderer — DO NOT EDIT MANUALLY -->
<!-- IVR ID: ${ivr.id} -->
<include>
  <context name="default">
${extensions}  </context>
</include>
`;
}

/** Generate 10_did_{e164digits}.xml — public context DID entry */
export function buildPublicContextXml(did: BuilderDid, ivr: BuilderIvr): string {
  const entryExt = nodeExtName(ivr.id, ivr.entryNodeId);
  const digits = did.e164Digits;

  let disclosure = "";
  if (did.recordingDisclosureAudio) {
    disclosure = `    <action application="playback" data="${escXml(did.recordingDisclosureAudio)}"/>\n`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generated by I02 IvrRenderer — DO NOT EDIT MANUALLY -->
<!-- DID: ${did.e164} → IVR ${ivr.id} -->
<include>
  <context name="public">
    <extension name="did_${digits}" continue="false">
      <condition field="destination_number" expression="^\\+?${digits}$">
        <action application="set" data="vici2_tenant_id=\${domain_name}"/>
        <action application="set" data="vici2_role=inbound"/>
        <action application="set" data="vici2_did_e164=${escXml(did.e164)}"/>
        <action application="set" data="vici2_ivr_id=${ivr.id}"/>
        <action application="set" data="vici2_ivr_lang=${escXml(did.defaultLang)}"/>
        <action application="set" data="vici2_ivr_path="/>
        <action application="set" data="vici2_ivr_digits="/>
        <action application="set" data="ivr_invalid_count=0"/>
        <action application="sched_transfer" data="+${did.ivrTimeoutSec} hangup XML default"/>
${disclosure}        <action application="transfer" data="${entryExt} XML default"/>
      </condition>
    </extension>
  </context>
</include>
`;
}
