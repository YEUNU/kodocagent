/**
 * doc-tools 내부 공통 타입
 * @kodocagent/core의 ToolDefinition/ToolContext와 동일한 구조 (순환 의존 방지)
 */
import type { z } from "zod";

export interface ToolContext {
  cwd: string;
  sessionId: string;
}

export interface ToolDefinition<TInput = unknown> {
  name: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  requiresApproval: boolean;
  execute: (opts: { input: TInput; signal?: AbortSignal; ctx: ToolContext }) => Promise<string>;
}
