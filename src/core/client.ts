/**
 * WindsurfClient — talks to the local language server via gRPC.
 */

import { randomUUID } from 'crypto';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { grpcFrame, grpcUnary } from './grpc.js';
import {
  buildInitializePanelStateRequest,
  buildAddTrackedWorkspaceRequest,
  buildUpdateWorkspaceTrustRequest,
  buildStartCascadeRequest,
  buildSendCascadeMessageRequest,
  buildGetTrajectoryStepsRequest,
  buildGetTrajectoryRequest,
  buildGetGeneratorMetadataRequest,
  CascadeConfigOptions,
  ChatToolCallInfo,
  TrajectoryRunCommandInfo,
  ImageAttachment,
  ServerUsage,
  parseStartCascadeResponse,
  parseCascadeTrajectoryId,
  parseTrajectoryStatus,
  parseTrajectorySteps,
  parseGeneratorMetadata,
} from './windsurf.js';
import { extractImages } from '../services/image.js';
import { log } from '../config.js';

const LS_SERVICE = '/exa.language_server_pb.LanguageServerService';

/**
 * Rewrite second-person identity declarations ("You are X") to third person
 * ("The assistant is X") before the text ships in Cascade's user-message
 * field. Without this, upstream Claude 4.7 matches the "You are X" pattern
 * on the user channel and refuses the whole request as prompt injection.
 */
function neutralizeIdentity(text: string): string {
  if (!text) return text;
  return text.replace(/(^|[\n.!?]\s*)You are /g, '$1The assistant is ');
}

/**
 * Claude Code injects ~100KB of English system prompt + tool definitions
 * which drowns out language instructions. Detect CJK/JP/KR in the user's
 * latest message and append a brief reminder to respond in the right language.
 */
const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/;
const JP_RE  = /[\u3040-\u309f\u30a0-\u30ff]/;
const KR_RE  = /[\uac00-\ud7af]/;

function injectLanguageHint(messages: any[]): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== 'user') continue;
    const text = String(messages[i].content || '');
    let hint = '';
    // Check JP/KR before CJK — Japanese text always contains kanji (CJK range)
    if (JP_RE.test(text))       hint = '\n\n[IMPORTANT: You MUST respond entirely in Japanese (日本語). Do not switch to English.]';
    else if (KR_RE.test(text))  hint = '\n\n[IMPORTANT: You MUST respond entirely in Korean (한국어). Do not switch to English.]';
    else if (CJK_RE.test(text)) hint = '\n\n[IMPORTANT: You MUST respond entirely in Chinese (中文). Do not switch to English.]';
    if (!hint) break;
    messages[i] = { ...messages[i], content: text + hint };
    break;
  }
}

export interface ChatChunk {
  text: string;
  thinking: string;
  toolCalls?: ChatToolCallInfo[];
  stepKind?: string | null;
  rawStep?: Buffer;
  stepIndex?: number;
  runCommand?: TrajectoryRunCommandInfo | null;
  requestedInteraction?: string | null;
  cascadeId?: string;
  trajectoryId?: string;
  serverUsage?: ServerUsage | null;
}

export class WindsurfClient {
  private apiKey: string;
  private port: number;
  private csrfToken: string;
  private sessionId: string;
  private cascadeId: string | null = null;
  private trajectoryId: string | null = null;
  private static _globalWarmupDone = false;

  static resetWarmup(): void {
    WindsurfClient._globalWarmupDone = false;
  }

  constructor(apiKey: string, port: number, csrfToken: string, sessionId?: string) {
    this.apiKey = apiKey;
    this.port = port;
    this.csrfToken = csrfToken;
    this.sessionId = sessionId || randomUUID();
  }

  async warmup(): Promise<void> {
    if (WindsurfClient._globalWarmupDone) return;
    try {
      const initProto = buildInitializePanelStateRequest(this.apiKey, this.sessionId);
      await grpcUnary(this.port, this.csrfToken, `${LS_SERVICE}/InitializeCascadePanelState`, grpcFrame(initProto), 5000);
    } catch (e: any) { log.warn('InitializeCascadePanelState:', e.message); }
    try {
      const wsDir = join(tmpdir(), 'windsurf-workspace');
      if (!existsSync(wsDir)) try { mkdirSync(wsDir, { recursive: true }); } catch { /* ignore */ }
      const wsProto = buildAddTrackedWorkspaceRequest(wsDir);
      await grpcUnary(this.port, this.csrfToken, `${LS_SERVICE}/AddTrackedWorkspace`, grpcFrame(wsProto), 5000);
    } catch (e: any) { log.warn('AddTrackedWorkspace:', e.message); }
    try {
      const trustProto = buildUpdateWorkspaceTrustRequest(this.apiKey, true, this.sessionId);
      await grpcUnary(this.port, this.csrfToken, `${LS_SERVICE}/UpdateWorkspaceTrust`, grpcFrame(trustProto), 5000);
    } catch (e: any) { log.warn('UpdateWorkspaceTrust:', e.message); }
    WindsurfClient._globalWarmupDone = true;
    log.debug('Cascade workspace init complete');
  }

  async startCascade(): Promise<string> {
    const startProto = buildStartCascadeRequest(this.apiKey, this.sessionId);
    const startResp = await grpcUnary(this.port, this.csrfToken, `${LS_SERVICE}/StartCascade`, grpcFrame(startProto));
    const cascadeId = parseStartCascadeResponse(startResp);
    if (!cascadeId) throw new Error('StartCascade returned empty cascade_id');
    this.cascadeId = cascadeId;
    return cascadeId;
  }

  getSessionInfo(): { sessionId: string; cascadeId: string | null; trajectoryId: string | null } {
    return { sessionId: this.sessionId, cascadeId: this.cascadeId, trajectoryId: this.trajectoryId };
  }

  async sendMessage(
    cascadeId: string, text: string,
    modelEnum: number, modelUid: string,
    options: CascadeConfigOptions = {},
  ): Promise<void> {
    const sendProto = buildSendCascadeMessageRequest(
      this.apiKey, cascadeId, text, modelEnum, modelUid, this.sessionId, options,
    );
    await grpcUnary(this.port, this.csrfToken, `${LS_SERVICE}/SendUserCascadeMessage`, grpcFrame(sendProto));
  }

  async *streamCascade(cascadeId: string, stepOffset = 0, maxWait = 180_000, inputChars = 0, hasDefaultMode = false): AsyncGenerator<ChatChunk> {
    this.cascadeId = cascadeId;
    const yieldedByStep = new Map<number, number>();
    const thinkingByStep = new Map<number, number>();
    const yieldedToolByStep = new Set<number>();
    const seenToolCallIds = new Set<string>();
    const seenErrorMsgs = new Set<string>();
    const startTime = Date.now();
    const pollInterval = 250;
    let idleCount = 0;
    let sawActive = false;
    let sawText = false;
    let totalYielded = 0;
    let totalThinking = 0;
    let lastStepCount = 0;
    let consecutiveErrors = 0;
    let lastStatus = -1;
    let endReason = 'unknown';
    let pollCount = 0;
    const MAX_CONSECUTIVE_ERRORS = 3;

    // "Progress" is ANY forward motion: text, thinking, new tool call, new step.
    // Using multi-signal tracking (not just text) prevents false stalls during
    // long thinking phases that Cascade legitimately uses.
    let lastGrowthAt = Date.now();
    let prevStatus = -1;
    const IDLE_GRACE_MS = 8_000;
    // DEFAULT mode (images/tools) needs longer stall window because Cascade
    // enters tool-execution trajectory steps that produce no text/thinking growth.
    const NO_GROWTH_STALL_MS = hasDefaultMode ? 60_000 : 25_000;
    const STALL_RETRY_MIN_TEXT = 100;

    while (Date.now() - startTime < maxWait) {
      await new Promise(r => setTimeout(r, pollInterval));
      pollCount++;

      let status: number;
      let steps: any[];
      let trajectoryId: string | null;

      try {
        const statusProto = buildGetTrajectoryRequest(cascadeId);
        const statusResp = await grpcUnary(this.port, this.csrfToken, `${LS_SERVICE}/GetCascadeTrajectory`, grpcFrame(statusProto));
        status = parseTrajectoryStatus(statusResp);
        trajectoryId = parseCascadeTrajectoryId(statusResp);
        if (trajectoryId) this.trajectoryId = trajectoryId;

        const stepsProto = buildGetTrajectoryStepsRequest(cascadeId, stepOffset);
        const stepsResp = await grpcUnary(this.port, this.csrfToken, `${LS_SERVICE}/GetCascadeTrajectorySteps`, grpcFrame(stepsProto));
        steps = parseTrajectorySteps(stepsResp);
        consecutiveErrors = 0;
      } catch (err: any) {
        consecutiveErrors++;
        log.warn(`Stream poll error (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}): ${err.message}`);
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          throw new Error(`Stream interrupted: ${err.message}`);
        }
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }

      lastStatus = status;

      // Status transitions count as growth (active↔idle means Cascade is doing something)
      if (prevStatus !== -1 && prevStatus !== status) {
        lastGrowthAt = Date.now();
      }
      prevStatus = status;

      // Error step detection (type 17)
      // Non-fatal errors (file already exists, tool failures) are logged but
      // don't kill the stream if we already have useful output.
      for (const step of steps) {
        if (step.type === 17 && step.errorText) {
          const errText = step.errorText.trim();
          if (!sawText && seenToolCallIds.size === 0) {
            // No output yet — treat as fatal
            const err = new Error(errText);
            (err as any).isModelError = true;
            throw err;
          }
          // Already have output — log once per unique message and continue
          if (!seenErrorMsgs.has(errText)) {
            seenErrorMsgs.add(errText);
            log.warn(`Cascade non-fatal error step: ${errText.slice(0, 120)}`);
          }
        }
      }

      // Cold stall: input-length-aware timeout
      // Tool-heavy payloads (hasDefaultMode) get 60s base instead of 30s
      const elapsed = Date.now() - startTime;
      const coldBase = hasDefaultMode ? 60_000 : 30_000;
      const coldStallMs = Math.min(maxWait, coldBase + Math.floor(inputChars / 1500) * 5_000);
      if (elapsed > coldStallMs && sawActive && !sawText && seenToolCallIds.size === 0) {
        log.warn(`Cascade cold stall: ${elapsed}ms active, no output (threshold=${coldStallMs}ms, inputChars=${inputChars})`);
        endReason = 'stall_cold';
        const err = new Error(`Cascade planner stalled — no output after ${Math.round(coldStallMs / 1000)}s`);
        (err as any).isModelError = true;
        throw err;
      }

      // Track new steps as growth
      if (steps.length > lastStepCount) {
        lastStepCount = steps.length;
        lastGrowthAt = Date.now();
      }

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const absIdx = stepOffset + i;

        // Tool calls (dedupe by id)
        if (step.toolCalls.length > 0) {
          for (const tc of step.toolCalls) {
            const key = tc.id || `${tc.name}:${tc.argumentsJson}`;
            if (seenToolCallIds.has(key)) continue;
            seenToolCallIds.add(key);
            lastGrowthAt = Date.now();
          }
          if (!yieldedToolByStep.has(absIdx)) {
            yieldedToolByStep.add(absIdx);
            yield {
              text: '', thinking: '', toolCalls: step.toolCalls,
              stepKind: step.stepKind, rawStep: step.rawStep, stepIndex: absIdx,
              runCommand: step.runCommand, requestedInteraction: step.requestedInteraction,
              cascadeId, trajectoryId: this.trajectoryId || undefined,
            };
          }
        }

        // Run commands
        if (step.runCommand && !yieldedToolByStep.has(absIdx)) {
          yieldedToolByStep.add(absIdx);
          lastGrowthAt = Date.now();
          yield {
            text: '', thinking: '', toolCalls: step.toolCalls,
            stepKind: step.stepKind, rawStep: step.rawStep, stepIndex: absIdx,
            runCommand: step.runCommand, requestedInteraction: step.requestedInteraction,
            cascadeId, trajectoryId: this.trajectoryId || undefined,
          };
        }

        // Thinking deltas — growth resets stall timer
        const liveThink = step.thinking || '';
        if (liveThink) {
          const prevThink = thinkingByStep.get(absIdx) || 0;
          if (liveThink.length > prevThink) {
            const delta = liveThink.slice(prevThink);
            thinkingByStep.set(absIdx, liveThink.length);
            totalThinking += delta.length;
            lastGrowthAt = Date.now();
            yield {
              text: '', thinking: delta, stepIndex: absIdx,
              stepKind: step.stepKind, requestedInteraction: step.requestedInteraction,
              cascadeId, trajectoryId: this.trajectoryId || undefined,
            };
          }
        }

        // Text deltas — prefer responseText (append-only) over modifiedText during streaming.
        // modifiedText is an LS post-pass rewrite that can change mid-stream, causing the
        // cursor-based slice to skip rewritten bytes. responseText stays monotonic.
        const liveText = step.responseText || step.text || '';
        if (!liveText) continue;
        const prev = yieldedByStep.get(absIdx) || 0;
        if (liveText.length > prev) {
          const delta = liveText.slice(prev);
          yieldedByStep.set(absIdx, liveText.length);
          totalYielded += delta.length;
          lastGrowthAt = Date.now();
          sawText = true;
          yield {
            text: delta, thinking: '', stepIndex: absIdx,
            stepKind: step.stepKind, requestedInteraction: step.requestedInteraction,
            cascadeId, trajectoryId: this.trajectoryId || undefined,
          };
        }
      }

      if (status !== 1) sawActive = true;

      // Warm stall: no growth while planner is active
      if (sawText && status !== 1 && (Date.now() - lastGrowthAt) > NO_GROWTH_STALL_MS) {
        const totalOutput = totalYielded + totalThinking;
        if (totalOutput < STALL_RETRY_MIN_TEXT) {
          log.warn('Cascade warm stall (short, retryable)', { textLen: totalYielded, thinkingLen: totalThinking, stallMs: NO_GROWTH_STALL_MS });
          endReason = 'stall_warm_retry';
          const err = new Error(`Cascade planner stalled after preamble — no progress for ${NO_GROWTH_STALL_MS / 1000}s`);
          (err as any).isModelError = true;
          throw err;
        }
        log.warn('Cascade warm stall (accepting partial)', { textLen: totalYielded, thinkingLen: totalThinking, stallMs: NO_GROWTH_STALL_MS });
        endReason = 'stall_warm';
        break;
      }

      if (status === 1) { // IDLE
        if (!sawActive && elapsed <= IDLE_GRACE_MS) continue;
        idleCount++;
        const growthSettled = (Date.now() - lastGrowthAt) > pollInterval * 2;
        const canBreak = sawText ? (idleCount >= 2 && growthSettled) : idleCount >= 4;
        if (canBreak) {
          // Final sweep: top-up with modifiedText if it's a strict extension
          const stepsProto = buildGetTrajectoryStepsRequest(cascadeId, stepOffset);
          try {
            const finalResp = await grpcUnary(this.port, this.csrfToken, `${LS_SERVICE}/GetCascadeTrajectorySteps`, grpcFrame(stepsProto));
            const finalSteps = parseTrajectorySteps(finalResp);
            for (let i = 0; i < finalSteps.length; i++) {
              const step = finalSteps[i];
              const absIdx = stepOffset + i;
              const responseText = step.responseText || '';
              const modifiedText = step.modifiedText || '';
              const prev = yieldedByStep.get(absIdx) || 0;

              // Normal top-up: responseText grew
              if (responseText.length > prev) {
                const delta = responseText.slice(prev);
                yieldedByStep.set(absIdx, responseText.length);
                totalYielded += delta.length;
                yield {
                  text: delta, thinking: '', stepIndex: absIdx,
                  cascadeId, trajectoryId: this.trajectoryId || undefined,
                };
              }
              // Modified top-up: only if modifiedText is a strict extension of responseText
              const cursor = yieldedByStep.get(absIdx) || 0;
              if (modifiedText.length > cursor && modifiedText.startsWith(responseText)) {
                const delta = modifiedText.slice(cursor);
                yieldedByStep.set(absIdx, modifiedText.length);
                totalYielded += delta.length;
                yield {
                  text: delta, thinking: '', stepIndex: absIdx,
                  cascadeId, trajectoryId: this.trajectoryId || undefined,
                };
              }
            }
          } catch (e: any) {
            log.debug(`Final sweep error: ${e.message}`);
          }
          endReason = sawText ? 'idle_done' : 'idle_empty';
          break;
        }
      } else {
        idleCount = 0;
      }
    }
    if (endReason === 'unknown') endReason = 'max_wait';

    // Structured summary for diagnostics
    const summary = {
      cascadeId: cascadeId.slice(0, 8),
      reason: endReason, polls: pollCount,
      textLen: totalYielded, thinkingLen: totalThinking,
      stepCount: Math.max(yieldedByStep.size, thinkingByStep.size, lastStepCount),
      toolCalls: seenToolCallIds.size, sawActive, sawText, lastStatus,
      ms: Date.now() - startTime,
    };
    if (totalYielded < 20 && endReason !== 'stall_cold' && endReason !== 'stall_warm_retry') {
      log.warn('Cascade short reply', summary);
    } else {
      log.info('Cascade done', summary);
    }

    // Fetch real token usage via GetCascadeTrajectoryGeneratorMetadata
    let serverUsage: ServerUsage | null = null;
    try {
      const metaReq = buildGetGeneratorMetadataRequest(cascadeId, 0);
      const metaResp = await grpcUnary(
        this.port, this.csrfToken,
        `${LS_SERVICE}/GetCascadeTrajectoryGeneratorMetadata`,
        grpcFrame(metaReq), 5000
      );
      serverUsage = parseGeneratorMetadata(metaResp);
      if (serverUsage) {
        log.info(`Cascade usage: in=${serverUsage.inputTokens} out=${serverUsage.outputTokens} cache_r=${serverUsage.cacheReadTokens} cache_w=${serverUsage.cacheWriteTokens}`);
      }
    } catch (e: any) {
      log.debug(`GetCascadeTrajectoryGeneratorMetadata: ${e.message}`);
    }

    // Yield a final empty chunk carrying the server usage so callers can use it
    if (serverUsage) {
      yield { text: '', thinking: '', cascadeId, serverUsage };
    }
  }

  /**
   * Format conversation messages (excluding system) into prompt text.
   * System prompt is handled separately via communicationText.
   */
  private formatConversation(messages: any[]): string {
    // Single user message — send as-is (most common, zero overhead)
    if (messages.length === 1 && messages[0].role === 'user') {
      return String(messages[0].content);
    }

    // Multi-turn: include conversation history so the model has context
    // Use XML-style tags that LLMs understand well
    const parts: string[] = [];
    parts.push('<conversation_history>');
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const content = String(msg.content);
      const isLast = i === messages.length - 1;

      if (isLast && msg.role === 'user') {
        // Last user message goes outside history tags as the actual query
        parts.push('</conversation_history>');
        parts.push('');
        parts.push(content);
        return parts.join('\n');
      }

      switch (msg.role) {
        case 'user':
          parts.push(`<user_message>${content}</user_message>`);
          break;
        case 'assistant':
          parts.push(`<assistant_message>${content}</assistant_message>`);
          break;
        case 'tool':
          parts.push(`<tool_result>${content}</tool_result>`);
          break;
        default:
          parts.push(`<${msg.role}>${content}</${msg.role}>`);
      }
    }
    parts.push('</conversation_history>');
    return parts.join('\n');
  }

  async *streamChat(
    messages: any[], modelEnum: number, modelUid: string,
    options: CascadeConfigOptions = {},
  ): AsyncGenerator<ChatChunk> {
    await this.warmup();
    const cascadeId = await this.startCascade();

    // Extract system prompt → pass as communicationText for proper handling
    const systemMsgs = messages.filter((m: any) => m.role === 'system');
    const nonSystemMsgs = messages.filter((m: any) => m.role !== 'system');
    const systemPrompt = systemMsgs.map((m: any) => String(m.content)).join('\n');

    const mergedOpts = { ...options };
    if (systemPrompt) {
      mergedOpts.communicationText = neutralizeIdentity(systemPrompt);
    }

    // Inject language hint for CJK/JP/KR user messages
    injectLanguageHint(nonSystemMsgs);

    // Extract images from the last user message (multimodal support)
    const images: ImageAttachment[] = [];
    for (let i = nonSystemMsgs.length - 1; i >= 0; i--) {
      const msg = nonSystemMsgs[i];
      if (msg.role !== 'user' || typeof msg.content === 'string') continue;
      if (!Array.isArray(msg.content)) continue;
      const { text: extractedText, images: extractedImages } = await extractImages(msg.content);
      if (extractedImages.length > 0) {
        images.push(...extractedImages);
        // Replace content array with plain text for Cascade
        nonSystemMsgs[i] = { ...msg, content: extractedText };
        log.info(`Extracted ${extractedImages.length} image(s) from user message`);
      }
      break; // Only process last user message
    }
    if (images.length > 0) {
      mergedOpts.images = images;
    }

    const text = this.formatConversation(nonSystemMsgs);
    const inputChars = text.length + (mergedOpts.communicationText?.length || 0);
    const hasTools = /Available (?:tools|functions)|<tool_call>/i.test(mergedOpts.communicationText || '');
    // Detailed input breakdown for debugging
    const roleCounts = nonSystemMsgs.reduce((acc: Record<string, number>, m: any) => {
      acc[m.role] = (acc[m.role] || 0) + 1;
      return acc;
    }, {});
    log.info(`streamChat: ${messages.length} msgs [${Object.entries(roleCounts).map(([r, c]) => `${r}=${c}`).join(', ')}], conversation=${text.length} chars, system=${mergedOpts.communicationText?.length || 0} chars, total=${inputChars} chars`);
    await this.sendMessage(cascadeId, text, modelEnum, modelUid, mergedOpts);
    yield* this.streamCascade(cascadeId, 0, 180_000, inputChars, !!images.length || hasTools);
  }
}
