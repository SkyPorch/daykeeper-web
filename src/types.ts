import type { components, operations, paths } from "./generated/schema.js";

type Schemas = components["schemas"];

export type DaykeeperConversation = Schemas["Conversation"];
export type DaykeeperAttachment = Schemas["Attachment"];
export type DaykeeperMessage = Schemas["Message"];
export type DaykeeperMessageSender = Schemas["MessageSender"];
export type DaykeeperCustomerIdentity = Schemas["CustomerIdentity"];
export type DaykeeperConversationList = Schemas["ConversationList"];
export type DaykeeperConversationResult = Schemas["ConversationResult"];
export type DaykeeperUnreadSummary = Schemas["UnreadSummary"];
export type DaykeeperSeenResult = Schemas["SeenResult"];
export type DaykeeperMessageList = Schemas["MessageList"];
export type DaykeeperMessageResult = Schemas["MessageResult"];
export type DaykeeperClaimConversationResult =
  Schemas["ClaimConversationResult"];

/** Customer methods only; backend lifecycle and erasure are not browser APIs. */
export type DaykeeperCustomerOpenApiPaths = Pick<
  paths,
  | "/v1/identity"
  | "/v1/conversations"
  | "/v1/unread"
  | "/v1/conversations/{conversationId}/seen"
  | "/v1/conversations/{conversationId}/messages"
  | "/v1/anonymous-conversations/claim"
>;
export type DaykeeperCustomerOpenApiOperations = Pick<
  operations,
  | "getCustomerIdentity"
  | "listCustomerConversations"
  | "createCustomerConversation"
  | "getCustomerUnread"
  | "markCustomerConversationSeen"
  | "listCustomerMessages"
  | "sendCustomerMessage"
  | "claimAnonymousConversation"
>;
