/**
 * Protobuf message builders and parsers for Windsurf language server.
 */

import { randomUUID } from 'crypto';
import {
  writeVarintField, writeStringField, writeMessageField,
  writeBoolField, parseFields, getField, getAllFields,
} from './proto.js';
import { log } from '../config.js';

const SOURCE = { USER: 1, SYSTEM: 2, ASSISTANT: 3, TOOL: 4 };

const STEP_KIND_FIELDS: Record<number, string> = {
  19: 'user_input',
  20: 'planner_response',
  23: 'write_to_file',
  24: 'error_message',
  28: 'run_command',
  37: 'command_status',
  45: 'custom_tool',
  47: 'mcp_tool',
  49: 'tool_call_proposal',
  50: 'tool_call_choice',
};

export enum PlannerMode {
  UNSPECIFIED = 0,
  DEFAULT = 1,
  READ_ONLY = 2,
  NO_TOOL = 3,
  EXPLORE = 4,
  PLANNING = 5,
  AUTO = 6,
}

export interface ImageAttachment {
  mimeType: string;
  base64: string;
}

export interface CascadeConfigOptions {
  plannerMode?: PlannerMode;
  communicationText?: string;
  includeCommunicationOverride?: boolean;
  thinkingBudget?: number;
  images?: ImageAttachment[];
}

export interface ChatToolCallInfo {
  id: string;
  name: string;
  argumentsJson: string;
}

export interface TrajectoryRunCommandInfo {
  commandId: string;
  commandLine: string;
  proposedCommandLine: string;
  cwd: string;
  stdout: string;
  stderr: string;
  combinedOutput: string;
  exitCode: number | null;
}

export interface TrajectoryStep {
  type: number;
  status: number;
  stepKind: string | null;
  text: string;
  responseText: string;
  modifiedText: string;
  thinking: string;
  errorText: string;
  toolCalls: ChatToolCallInfo[];
  requestedInteraction: string | null;
  runCommand: TrajectoryRunCommandInfo | null;
  rawStep: Buffer;
}

export interface ServerUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

function encodeTimestamp(): Buffer {
  const now = Date.now();
  const secs = Math.floor(now / 1000);
  const nanos = (now % 1000) * 1_000_000;
  const parts = [writeVarintField(1, secs)];
  if (nanos > 0) parts.push(writeVarintField(2, nanos));
  return Buffer.concat(parts);
}

export function buildMetadata(apiKey: string, version = '1.9600.41', sessionId: string | null = null): Buffer {
  return Buffer.concat([
    writeStringField(1, 'windsurf'),
    writeStringField(2, version),
    writeStringField(3, apiKey),
    writeStringField(4, 'en'),
    writeStringField(5, 'linux'),
    writeStringField(7, version),
    writeStringField(8, 'x86_64'),
    writeVarintField(9, Date.now()),
    writeStringField(10, sessionId || randomUUID()),
    writeStringField(12, 'windsurf'),
  ]);
}

function buildChatMessage(content: string, source: number, conversationId: string): Buffer {
  const parts = [
    writeStringField(1, randomUUID()),
    writeVarintField(2, source),
    writeMessageField(3, encodeTimestamp()),
    writeStringField(4, conversationId),
  ];
  if (source === SOURCE.ASSISTANT) {
    parts.push(writeStringField(5, content));
  } else {
    const intentGeneric = writeStringField(1, content);
    const intent = writeMessageField(1, intentGeneric);
    parts.push(writeMessageField(5, intent));
  }
  return Buffer.concat(parts);
}

export function buildRawGetChatMessageRequest(apiKey: string, messages: any[], modelEnum: number, modelName?: string): Buffer {
  const parts: Buffer[] = [];
  const conversationId = randomUUID();
  parts.push(writeMessageField(1, buildMetadata(apiKey)));

  let systemPrompt = '';
  for (const msg of messages) {
    if (msg.role === 'system') {
      systemPrompt += (systemPrompt ? '\n' : '') + String(msg.content);
      continue;
    }
    let source: number;
    switch (msg.role) {
      case 'user': source = SOURCE.USER; break;
      case 'assistant': source = SOURCE.ASSISTANT; break;
      case 'tool': source = SOURCE.TOOL; break;
      default: source = SOURCE.USER;
    }
    const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    parts.push(writeMessageField(2, buildChatMessage(text, source, conversationId)));
  }

  if (systemPrompt) parts.push(writeStringField(3, systemPrompt));
  parts.push(writeVarintField(4, modelEnum));
  if (modelName) parts.push(writeStringField(5, modelName));
  return Buffer.concat(parts);
}

export function buildInitializePanelStateRequest(apiKey: string, sessionId: string, trusted = true): Buffer {
  return Buffer.concat([
    writeMessageField(1, buildMetadata(apiKey, undefined, sessionId)),
    writeBoolField(3, trusted),
  ]);
}

export function buildAddTrackedWorkspaceRequest(workspacePath: string): Buffer {
  return writeStringField(1, workspacePath);
}

export function buildUpdateWorkspaceTrustRequest(apiKey: string, trusted = true, sessionId: string): Buffer {
  return Buffer.concat([
    writeMessageField(1, buildMetadata(apiKey, undefined, sessionId)),
    writeBoolField(2, trusted),
  ]);
}

export function buildStartCascadeRequest(apiKey: string, sessionId: string): Buffer {
  return writeMessageField(1, buildMetadata(apiKey, undefined, sessionId));
}

export function parseStartCascadeResponse(buf: Buffer): string {
  const fields = parseFields(buf);
  const f1 = getField(fields, 1, 2);
  return f1 ? (f1.value as Buffer).toString('utf8') : '';
}

export function buildCascadeConfig(
  modelEnum: number,
  modelUid: string | null,
  options: CascadeConfigOptions = {},
): Buffer {
  // Always use NO_TOOL (3). DEFAULT (1) enables Cascade's full IDE agent loop
  // which triggers create_file/edit_file/view_file even with SectionOverrideConfig.
  // Images are still attached via protobuf field 6 — the LS routes them to the
  // vision pipeline regardless of planner mode.
  const hasImages = !!options.images?.length;
  const plannerMode = options.plannerMode ?? PlannerMode.NO_TOOL;
  const communicationText = options.communicationText ?? 'You are an AI assistant accessed via API.';

  const convParts = [writeVarintField(4, plannerMode)];

  // Helper: build SectionOverrideConfig { mode=1 (OVERRIDE), content=text }
  const sectionOverride = (text: string) => Buffer.concat([
    writeVarintField(1, 1),       // SECTION_OVERRIDE_MODE_OVERRIDE
    writeStringField(2, text),
  ]);

  // Detect if the caller (e.g. Claude Code) injected tool definitions into
  // the system prompt. If so, the model must believe it has tool capabilities.
  const hasClientTools = /\btool_use\b|<tool_call>|<tool>|function_calls|<tools>|Available (?:tools|functions)|\bBash\b.*\bcommand\b/is.test(communicationText);

  if (hasClientTools) {
    // ── Client provides tools (Claude Code, Cursor, etc.) ──
    // Override tool_calling_section (field 10): redirect the model to use
    // <tool_call> format from the system instructions instead of Cascade's IDE tools.
    convParts.push(writeMessageField(10, sectionOverride(
      'Ignore any Windsurf or Cascade IDE tools (create_file, edit_file, view_file, etc.). ' +
      'You have access to the tools defined in your system instructions. ' +
      'When you need to call a tool, use the <tool_call> format specified there. ' +
      'NEVER say "I don\'t have access to tools" — the functions in your system instructions ARE your tools.'
    )));

    // Override additional_instructions (field 12): context clarification
    convParts.push(writeMessageField(12, sectionOverride(
      'You are accessed via API. Your tool capabilities come from the system instructions provided by the caller. ' +
      'You are NOT inside the Windsurf or Cascade IDE. Do not mention Windsurf, Cascade, Write mode, Chat mode, or Agent mode.'
    )));

    // Override communication_section (field 13): pass through client system prompt
    // with minimal identity correction (don't add "no tools" restrictions!)
    convParts.push(writeMessageField(13, sectionOverride(communicationText)));
  } else {
    // ── No client tools (plain chat) ──
    // Override tool_calling_section (field 10): suppress built-in tool list
    convParts.push(writeMessageField(10, sectionOverride('No tools are available.')));

    // Override additional_instructions (field 12): reinforce direct-answer mode
    const additionalInstr = hasImages
      ? 'You have no tools, no file access, and no command execution. ' +
        'Focus on analyzing any provided images and answering the user directly. ' +
        'Never pretend to create files or check directories.'
      : 'You have no tools, no file access, and no command execution. ' +
        'Answer all questions directly using your knowledge. ' +
        'Never pretend to create files or check directories.';
    convParts.push(writeMessageField(12, sectionOverride(additionalInstr)));

    // Override communication_section (field 13): strip IDE-assistant persona
    convParts.push(writeMessageField(13, sectionOverride(
      communicationText + '\n\n' +
      'You are NOT running inside an IDE or code editor. ' +
      'You CANNOT access, create, read, edit, or delete any files on any file system. ' +
      'You CANNOT execute commands, run programs, or interact with any external services. ' +
      'You do NOT have "Write mode", "Chat mode", "Agent mode", or any other modes. ' +
      'You are NOT called Windsurf, Cascade, or any IDE-related name. ' +
      'Never suggest switching modes, opening panels, or using IDE features. ' +
      'Answer all questions directly using your training knowledge.'
    )));
  }

  const conversationalConfig = Buffer.concat(convParts);
  const plannerParts = [writeMessageField(2, conversationalConfig)];

  if (modelUid) {
    plannerParts.push(writeStringField(35, modelUid));
  } else {
    plannerParts.push(writeMessageField(15, writeVarintField(1, modelEnum)));
  }

  const plannerConfig = Buffer.concat(plannerParts);

  // Brain config — field 7
  // field 1 = 1 (enabled), field 6.6 = thinking config
  const thinkingBudget = options.thinkingBudget ?? 128000;
  const thinkingInner = Buffer.concat([
    writeVarintField(1, thinkingBudget),  // budget_tokens
  ]);
  const brainConfig = Buffer.concat([
    writeVarintField(1, 1),
    writeMessageField(6, writeMessageField(6, thinkingInner)),
  ]);

  return Buffer.concat([
    writeMessageField(1, plannerConfig),
    writeMessageField(7, brainConfig),
  ]);
}

export function buildTextItem(text: string): Buffer {
  return writeStringField(1, text);
}

export function buildSendCascadeMessageRequest(
  apiKey: string, cascadeId: string, text: string,
  modelEnum: number, modelUid: string | null, sessionId: string,
  options: CascadeConfigOptions = {},
): Buffer {
  const parts = [
    writeStringField(1, cascadeId),
    writeMessageField(2, buildTextItem(text)),
    writeMessageField(3, buildMetadata(apiKey, undefined, sessionId)),
    writeMessageField(5, buildCascadeConfig(modelEnum, modelUid, options)),
  ];

  // Field 6: repeated ImageData { base64_data=1, mime_type=2 }
  if (options.images?.length) {
    for (const img of options.images) {
      const imgMsg = Buffer.concat([
        writeStringField(1, img.base64),
        writeStringField(2, img.mimeType || 'image/png'),
      ]);
      parts.push(writeMessageField(6, imgMsg));
    }
    log.info(`Attached ${options.images.length} image(s) to Cascade request`);
  }

  return Buffer.concat(parts);
}

export function buildGetTrajectoryStepsRequest(cascadeId: string, stepOffset = 0): Buffer {
  const parts = [writeStringField(1, cascadeId)];
  if (stepOffset > 0) parts.push(writeVarintField(2, stepOffset));
  return Buffer.concat(parts);
}

export function buildGetTrajectoryRequest(cascadeId: string): Buffer {
  return writeStringField(1, cascadeId);
}

export function parseTrajectoryStatus(buf: Buffer): number {
  const fields = parseFields(buf);
  const f2 = getField(fields, 2, 0);
  return f2 ? (f2.value as number) : 0;
}

export function parseCascadeTrajectoryId(buf: Buffer): string {
  const fields = parseFields(buf);
  const trajectoryField = getField(fields, 1, 2);
  if (!trajectoryField) return '';
  const trajectoryFields = parseFields(trajectoryField.value as Buffer);
  const trajectoryIdField = getField(trajectoryFields, 1, 2);
  return trajectoryIdField ? (trajectoryIdField.value as Buffer).toString('utf8') : '';
}

function detectStepKind(fields: ReturnType<typeof parseFields>): string | null {
  for (const [fieldNum, name] of Object.entries(STEP_KIND_FIELDS)) {
    if (getField(fields, Number(fieldNum), 2)) return name;
  }
  return null;
}

function parseChatToolCall(buf: Buffer): ChatToolCallInfo {
  const fields = parseFields(buf);
  const readStr = (n: number) => {
    const f = getField(fields, n, 2);
    return f ? (f.value as Buffer).toString('utf8') : '';
  };
  return { id: readStr(1), name: readStr(2), argumentsJson: readStr(3) };
}

function readErrorText(buf: Buffer): string {
  const errorFields = parseFields(buf);
  for (const fieldNum of [1, 2, 3, 5]) {
    const field = getField(errorFields, fieldNum, 2);
    if (!field) continue;
    const text = (field.value as Buffer).toString('utf8').trim();
    if (text) return text.split('\n')[0].slice(0, 300);
  }
  return '';
}

export function parseTrajectorySteps(buf: Buffer): TrajectoryStep[] {
  const fields = parseFields(buf);
  const steps = getAllFields(fields, 1).filter(f => f.wireType === 2);
  const results: TrajectoryStep[] = [];

  for (const step of steps) {
    const sf = parseFields(step.value as Buffer);
    const typeField = getField(sf, 1, 0);
    const statusField = getField(sf, 4, 0);
    const plannerField = getField(sf, 20, 2);
    const stepKind = detectStepKind(sf);

    // Debug: scan top-level step fields to find brain/thinking data
    const stepDebug: string[] = [];
    for (const candidate of [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 21, 22, 25, 26, 27, 29, 30, 32, 33, 34, 35]) {
      const f = getField(sf, candidate, 2);
      if (f) stepDebug.push(`sf${candidate}:${((f.value as Buffer).length)}b`);
    }
    if (stepDebug.length > 0 && stepKind === 'planner_response') {
      log.debug(`Step top-level fields (kind=${stepKind}): ${stepDebug.join(', ')}`);
    }

    const entry: TrajectoryStep = {
      type: typeField ? (typeField.value as number) : 0,
      status: statusField ? (statusField.value as number) : 0,
      stepKind,
      text: '',
      responseText: '',
      modifiedText: '',
      thinking: '',
      errorText: '',
      toolCalls: [],
      requestedInteraction: null,
      runCommand: null,
      rawStep: step.value as Buffer,
    };

    const errMsgField = getField(sf, 24, 2);
    if (errMsgField) {
      const inner = getField(parseFields(errMsgField.value as Buffer), 3, 2);
      if (inner) entry.errorText = readErrorText(inner.value as Buffer);
    }
    if (!entry.errorText) {
      const errField = getField(sf, 31, 2);
      if (errField) entry.errorText = readErrorText(errField.value as Buffer);
    }

    if (plannerField) {
      const pf = parseFields(plannerField.value as Buffer);
      const textField = getField(pf, 1, 2);
      const modifiedField = getField(pf, 8, 2);
      const thinkField = getField(pf, 3, 2);

      // Scan all planner string fields for debugging
      const debugFields: string[] = [];
      for (let fnum = 1; fnum <= 12; fnum++) {
        const f = getField(pf, fnum, 2);
        if (f) debugFields.push(`f${fnum}:${((f.value as Buffer).length)}b`);
      }
      if (debugFields.length > 0) {
        log.debug(`Planner fields: ${debugFields.join(', ')}`);
      }

      const responseText = textField ? (textField.value as Buffer).toString('utf8') : '';
      const modifiedText = modifiedField ? (modifiedField.value as Buffer).toString('utf8') : '';
      let rawText = modifiedText || responseText;
      entry.responseText = responseText;
      entry.modifiedText = modifiedText;

      // Primary: thinking from protobuf field 3
      let thinking = '';
      if (thinkField) {
        thinking = (thinkField.value as Buffer).toString('utf8');
      }

      // Fallback: extract <thinking> or <Thought> tags embedded in text
      if (!thinking && rawText) {
        const thinkingMatch = rawText.match(/<thinking>([\s\S]*?)<\/thinking>/);
        const thoughtMatch = rawText.match(/<Thought>([\s\S]*?)<\/Thought>/);
        const reasonMatch = rawText.match(/<reasoning>([\s\S]*?)<\/reasoning>/);
        const match = thinkingMatch || thoughtMatch || reasonMatch;
        if (match) {
          thinking = match[1].trim();
          rawText = rawText.replace(match[0], '').trim();
          log.debug(`Extracted thinking from text tags (${thinking.length}b)`);
        }
      }

      entry.text = rawText;
      entry.thinking = thinking;

      if (thinking) log.debug(`Step thinking: ${thinking.slice(0, 80)}...`);
      if (rawText) log.debug(`Step text: ${rawText.slice(0, 80)}...`);
    }

    const proposalField = getField(sf, 49, 2);
    if (proposalField) {
      const pFields = parseFields(proposalField.value as Buffer);
      const callField = getField(pFields, 1, 2);
      if (callField) entry.toolCalls.push(parseChatToolCall(callField.value as Buffer));
    }

    const choiceField = getField(sf, 50, 2);
    if (choiceField) {
      const cFields = parseFields(choiceField.value as Buffer);
      const callFields = getAllFields(cFields, 1).filter(f => f.wireType === 2);
      for (const callField of callFields) {
        entry.toolCalls.push(parseChatToolCall(callField.value as Buffer));
      }
    }

    const runCommandField = getField(sf, 28, 2);
    if (runCommandField) {
      const cmdFields = parseFields(runCommandField.value as Buffer);
      const readStr = (n: number) => {
        const f = getField(cmdFields, n, 2);
        return f ? (f.value as Buffer).toString('utf8') : '';
      };
      const exitCodeField = getField(cmdFields, 6, 0);
      const combinedField = getField(cmdFields, 21, 2);
      const combinedFields = combinedField ? parseFields(combinedField.value as Buffer) : [];
      const combinedOutputField = getField(combinedFields, 1, 2);
      entry.runCommand = {
        commandId: readStr(13),
        commandLine: readStr(23),
        proposedCommandLine: readStr(25),
        cwd: readStr(2),
        stdout: readStr(4),
        stderr: readStr(5),
        combinedOutput: combinedOutputField ? (combinedOutputField.value as Buffer).toString('utf8') : '',
        exitCode: exitCodeField ? (exitCodeField.value as number) : null,
      };
    }

    results.push(entry);
  }
  return results;
}

// ─── GetCascadeTrajectoryGeneratorMetadata ─────────────────
// Returns real token usage from Cascade backend.

export function buildGetGeneratorMetadataRequest(cascadeId: string, stepIndex = 0): Buffer {
  return Buffer.concat([
    writeStringField(1, cascadeId),
    writeVarintField(2, stepIndex),
  ]);
}

/**
 * Parse GetCascadeTrajectoryGeneratorMetadata response.
 * The response contains model_usage with real token counts:
 *   input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
 */
export function parseGeneratorMetadata(buf: Buffer): ServerUsage | null {
  if (!buf || buf.length === 0) return null;
  try {
    const fields = parseFields(buf);
    // The metadata is in a nested message structure.
    // Try field 1 (generator metadata), then look for usage submessage.
    const meta = getField(fields, 1, 2);
    if (!meta) return null;
    const mf = parseFields(meta.value as Buffer);

    // Look for model_usage submessage — try common field numbers
    for (const fieldNum of [5, 6, 7, 8, 10]) {
      const usageField = getField(mf, fieldNum, 2);
      if (!usageField) continue;
      const uf = parseFields(usageField.value as Buffer);

      const inputField = getField(uf, 1, 0);
      const outputField = getField(uf, 2, 0);
      const cacheReadField = getField(uf, 3, 0);
      const cacheWriteField = getField(uf, 4, 0);

      const inputTokens = inputField ? (inputField.value as number) : 0;
      const outputTokens = outputField ? (outputField.value as number) : 0;

      if (inputTokens || outputTokens) {
        return {
          inputTokens,
          outputTokens,
          cacheReadTokens: cacheReadField ? (cacheReadField.value as number) : 0,
          cacheWriteTokens: cacheWriteField ? (cacheWriteField.value as number) : 0,
        };
      }
    }

    return null;
  } catch (e: any) {
    log.debug(`parseGeneratorMetadata error: ${e.message}`);
    return null;
  }
}
