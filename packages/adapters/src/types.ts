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

export interface CompleteRequest {
  prompt: string;
  workdir: string;
  signal: AbortSignal;
  timeoutMs: number;
}

/** The only parts of a request the argument builders depend on. */
export type ArgsRequest = Pick<InvokeRequest, 'workdir' | 'harnessSessionId'>;

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
  /** One-shot raw prompt in a fresh session; returns trimmed non-empty text or throws AdapterError('crashed'). */
  complete(req: CompleteRequest): Promise<string>;
}

export type AdapterErrorCode = 'timeout' | 'aborted' | 'crashed' | 'unavailable';

export class AdapterError extends Error {
  constructor(public readonly code: AdapterErrorCode, message: string) {
    super(message);
    this.name = 'AdapterError';
  }
}
