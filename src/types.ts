import type { components } from "./generated/schema.js";

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
