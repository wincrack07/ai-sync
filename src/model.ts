/** Canonical, tool-neutral message used to move turns between Claude and Codex. */
export type Side = 'claude' | 'codex';
export type Role = 'user' | 'assistant';

export interface CanonMsg {
  /** Stable id of this message in its own file (Claude uuid, or derived hash for Codex). */
  id: string;
  role: Role;
  text: string;
  /** ISO-8601 timestamp; empty string when the source has none. */
  timestamp: string;
  /** 'tool' marks a rendered tool call summary rather than prose. */
  kind: 'text' | 'tool';
  /** When this message was written by ai-sync, the id of the message it mirrors. */
  mirrorOf?: string;
}

export interface Conversation {
  side: Side;
  path: string;
  /** Claude sessionId or Codex thread id. */
  id: string;
  cwd: string;
  title: string;
  messages: CanonMsg[];
  mtimeMs: number;
  size: number;
}

export const otherSide = (s: Side): Side => (s === 'claude' ? 'codex' : 'claude');
