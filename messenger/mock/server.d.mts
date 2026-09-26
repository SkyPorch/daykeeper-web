export const PUBLISHABLE_KEY: string;

export interface MockMessage {
  id: number;
  conversationId: number;
  content: string;
  messageType: number;
  createdAt: number;
  author: "customer" | "agent" | "human" | "system";
  sender: { name: string | null; avatarUrl: string | null } | null;
}

export interface MockState {
  config: Record<string, unknown>;
  visitors: string[];
  conversations: {
    id: number;
    sub: string;
    unreadForContact: number;
    messages: MockMessage[];
  }[];
  requests: { method: string; path: string; at: number }[];
}

export interface SeedThread {
  ageSeconds?: number;
  seen?: boolean;
  messages?: {
    author: "customer" | "agent" | "human" | "system";
    content: string;
    ageSeconds?: number;
    senderName?: string;
  }[];
}

export interface Mock {
  siteUrl: string;
  gatewayUrl: string;
  publishableKey: string;
  reply(body: {
    author?: "agent" | "human" | "system";
    content?: string;
    conversationId?: number;
    senderName?: string;
  }): Promise<{ message: MockMessage }>;
  configure(body: Record<string, unknown>): Promise<unknown>;
  fail(body: {
    route:
      "sessions" | "list" | "create" | "unread" | "messages" | "send" | "seen";
    status?: number;
    code?: string;
    times?: number;
  }): Promise<unknown>;
  revoke(): Promise<unknown>;
  rotateSigningKey(): Promise<unknown>;
  reset(): Promise<unknown>;
  seed(body: { conversations: SeedThread[] }): Promise<{
    visitorId: string;
    secret: string;
    hasConversation: boolean;
  }>;
  state(): Promise<MockState>;
  close(): Promise<void>;
}

export function startMock(options?: {
  sitePort?: number;
  gatewayPort?: number;
  log?: boolean;
}): Promise<Mock>;
