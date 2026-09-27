/**
 * Every visitor-facing string. English is the only catalogue in v1; a new
 * locale is a new object of the same shape, selected in `stringsFor`.
 * Never build sentences by concatenating catalogue entries: word order differs
 * between languages, so parameterised entries take their values as arguments.
 */
export interface Strings {
  openMessenger: string;
  closeMessenger: string;
  unreadCount: (count: number) => string;
  close: string;
  back: string;
  defaultGreeting: string;
  startTitle: string;
  startBody: string;
  newConversation: string;
  yourConversations: string;
  conversationFallbackPreview: string;
  composerLabel: string;
  composerPlaceholder: string;
  send: string;
  you: string;
  justNow: string;
  aiAgent: string;
  teamMember: string;
  sending: string;
  sent: string;
  notDelivered: string;
  maybeNotDelivered: string;
  retry: string;
  charactersLeft: (count: number) => string;
  tooLong: (max: number) => string;
  newMessages: string;
  newMessageFrom: (name: string, text: string) => string;
  poweredBy: string;
  loading: string;
  errors: {
    unavailableTitle: string;
    unavailableBody: string;
    notSetUpTitle: string;
    notSetUpBody: string;
    connectionTitle: string;
    connectionBody: string;
    genericTitle: string;
    genericBody: string;
    sendLimited: string;
    offline: string;
    tryAgain: string;
  };
}

export const en: Strings = {
  openMessenger: "Open support chat",
  closeMessenger: "Close support chat",
  unreadCount: (count) =>
    count === 1 ? "1 unread message" : `${count} unread messages`,
  close: "Close",
  back: "Back to conversations",
  defaultGreeting: "Hi there. How can we help?",
  startTitle: "Send us a message",
  startBody: "Ask a question or tell us what's going on. We'll reply here.",
  newConversation: "New conversation",
  yourConversations: "Your conversations",
  conversationFallbackPreview: "No messages yet",
  composerLabel: "Message",
  composerPlaceholder: "Write a message…",
  send: "Send message",
  you: "You",
  justNow: "Just now",
  aiAgent: "AI agent",
  teamMember: "Support team",
  sending: "Sending…",
  sent: "Sent",
  notDelivered: "Not delivered.",
  maybeNotDelivered: "We couldn't confirm this was sent.",
  retry: "Retry",
  charactersLeft: (count) =>
    count === 1 ? "1 character left" : `${count} characters left`,
  tooLong: (max) => `Messages can be up to ${max.toLocaleString()} characters.`,
  newMessages: "New messages",
  newMessageFrom: (name, text) => `${name}: ${text}`,
  poweredBy: "Powered by Daykeeper",
  loading: "Loading",
  errors: {
    unavailableTitle: "Chat is unavailable",
    unavailableBody:
      "This chat isn't taking messages right now. Please check back later.",
    notSetUpTitle: "Chat isn't set up here",
    notSetUpBody:
      "This website isn't connected to its support inbox yet. Please contact the site another way.",
    connectionTitle: "We can't connect",
    connectionBody:
      "Check your connection and try again. Your messages are safe.",
    genericTitle: "Something went wrong",
    genericBody: "Please try again in a moment.",
    sendLimited:
      "Messages can't be sent right now. Please try again later or contact us another way.",
    offline: "Connection lost. Reconnecting…",
    tryAgain: "Try again",
  },
};

export function stringsFor(_locale: string | undefined): Strings {
  return en;
}
