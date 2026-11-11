export interface ChatMessage {
  id: string;
  senderName: string;
  body: string;
  createdAt: number;
  /** Absolute paths readable from the agent's workdir. */
  attachments: string[];
}

export interface InvokeRequest {
  conversationId: string;
  agentName: string;
  conversationTitle: string;
  isGroup: boolean;
  /** null means start a fresh harness session. */
  harnessSessionId: string | null;
  newMessages: ChatMessage[];
  workdir: string;
  signal: AbortSignal;
  timeoutMs: number;
  onTyping?: () => void;
}

export type InvokeResult =
  | { kind: 'reply'; body: string; harnessSessionId: string }
  | { kind: 'silent'; harnessSessionId: string };

export interface Availability {
  ok: boolean;
  reason?: string;
}

export interface AgentAdapter {
  /** Stable identifier, also the workspace directory name. */
  readonly name: string;
  readonly displayName: string;
  readonly defaultBio: string;
  check(): Promise<Availability>;
  invoke(req: InvokeRequest): Promise<InvokeResult>;
}

export type AdapterErrorCode = 'timeout' | 'aborted' | 'crashed' | 'unavailable';

export class AdapterError extends Error {
  constructor(public readonly code: AdapterErrorCode, message: string) {
    super(message);
    this.name = 'AdapterError';
  }
}
