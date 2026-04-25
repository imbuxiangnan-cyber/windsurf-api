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
  CascadeConfigOptions,
  ChatToolCallInfo,
  TrajectoryRunCommandInfo,
  parseStartCascadeResponse,
  parseCascadeTrajectoryId,
  parseTrajectoryStatus,
  parseTrajectorySteps,
} from './windsurf.js';
import { log } from '../config.js';

const LS_SERVICE = '/exa.language_server_pb.LanguageServerService';

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
}

export class WindsurfClient {
  private apiKey: string;
  private port: number;
  private csrfToken: string;
  private sessionId: string;
  private cascadeId: string | null = null;
  private trajectoryId: string | null = null;
  private workspaceInit = false;

  constructor(apiKey: string, port: number, csrfToken: string, sessionId?: string) {
    this.apiKey = apiKey;
    this.port = port;
    this.csrfToken = csrfToken;
    this.sessionId = sessionId || randomUUID();
  }

  async warmup(): Promise<void> {
    if (this.workspaceInit) return;
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
    this.workspaceInit = true;
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

  async *streamCascade(cascadeId: string, stepOffset = 0, maxWait = 180_000): AsyncGenerator<ChatChunk> {
    this.cascadeId = cascadeId;
    const yieldedByStep = new Map<number, number>();
    const thinkingByStep = new Map<number, number>();
    const yieldedToolByStep = new Set<number>();
    const startTime = Date.now();
    const pollInterval = 250;
    let idleCount = 0;
    let sawActive = false;
    let sawText = false;
    let consecutiveErrors = 0;
    const MAX_CONSECUTIVE_ERRORS = 3;

    while (Date.now() - startTime < maxWait) {
      await new Promise(r => setTimeout(r, pollInterval));

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

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const absIdx = stepOffset + i;

        if (step.type === 17 && step.errorText) {
          throw new Error(step.errorText);
        }

        if (step.toolCalls.length > 0 && !yieldedToolByStep.has(absIdx)) {
          yieldedToolByStep.add(absIdx);
          yield {
            text: '', thinking: '', toolCalls: step.toolCalls,
            stepKind: step.stepKind, rawStep: step.rawStep, stepIndex: absIdx,
            runCommand: step.runCommand, requestedInteraction: step.requestedInteraction,
            cascadeId, trajectoryId: this.trajectoryId || undefined,
          };
        }

        if (step.runCommand && !yieldedToolByStep.has(absIdx)) {
          yieldedToolByStep.add(absIdx);
          yield {
            text: '', thinking: '', toolCalls: step.toolCalls,
            stepKind: step.stepKind, rawStep: step.rawStep, stepIndex: absIdx,
            runCommand: step.runCommand, requestedInteraction: step.requestedInteraction,
            cascadeId, trajectoryId: this.trajectoryId || undefined,
          };
        }

        const liveThink = step.thinking || '';
        if (liveThink) {
          const prevThink = thinkingByStep.get(absIdx) || 0;
          if (liveThink.length > prevThink) {
            const delta = liveThink.slice(prevThink);
            thinkingByStep.set(absIdx, liveThink.length);
            yield {
              text: '', thinking: delta, stepIndex: absIdx,
              stepKind: step.stepKind, requestedInteraction: step.requestedInteraction,
              cascadeId, trajectoryId: this.trajectoryId || undefined,
            };
          }
        }

        const liveText = step.text || '';
        if (!liveText) continue;
        const prev = yieldedByStep.get(absIdx) || 0;
        if (liveText.length > prev) {
          const delta = liveText.slice(prev);
          yieldedByStep.set(absIdx, liveText.length);
          sawText = true;
          yield {
            text: delta, thinking: '', stepIndex: absIdx,
            stepKind: step.stepKind, requestedInteraction: step.requestedInteraction,
            cascadeId, trajectoryId: this.trajectoryId || undefined,
          };
        }
      }

      if (status !== 1) sawActive = true;
      if (status === 1) {
        const elapsed = Date.now() - startTime;
        if (!sawActive && elapsed <= 8000) continue;
        idleCount++;
        const canBreak = sawText ? idleCount >= 2 : idleCount >= 4;
        if (canBreak) break;
      } else {
        idleCount = 0;
      }
    }
  }

  async *streamChat(
    messages: any[], modelEnum: number, modelUid: string,
    options: CascadeConfigOptions = {},
  ): AsyncGenerator<ChatChunk> {
    await this.warmup();
    const cascadeId = await this.startCascade();
    const userMsg = messages.filter((m: any) => m.role === 'user').pop();
    const text = userMsg ? String(userMsg.content) : '';
    await this.sendMessage(cascadeId, text, modelEnum, modelUid, options);
    yield* this.streamCascade(cascadeId, 0);
  }
}
