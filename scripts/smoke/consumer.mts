import {
  createDaykeeperWebClient,
  type DaykeeperCustomerOpenApiOperations,
  type DaykeeperCustomerOpenApiPaths,
  type DaykeeperMessageList,
} from "@skyporch/daykeeper-web";
const client = createDaykeeperWebClient({
  baseUrl: "https://support.example.com/support-api",
  getAccessToken: ({ signal, forceRefresh }) => {
    const abortSignal: AbortSignal = signal;
    const refresh: boolean = forceRefresh;
    void abortSignal;
    void refresh;
    return "synthetic-customer-token";
  },
});
const messages: Promise<DaykeeperMessageList> = client.listMessages(1, {
  after: 2,
  signal: new AbortController().signal,
});
void messages;
type Identity = DaykeeperCustomerOpenApiOperations["getCustomerIdentity"];
type Conversations = DaykeeperCustomerOpenApiPaths["/v1/conversations"];
type Operations = DaykeeperCustomerOpenApiOperations;
// @ts-expect-error Backend lifecycle operations are not browser API exports.
type NoLifecycle = Operations["deliverCustomerLifecycleMessage"];
// @ts-expect-error Backend erasure paths are not browser API exports.
type NoErasure = DaykeeperCustomerOpenApiPaths["/v1/contacts"];
// @ts-expect-error There is no generic request escape hatch.
client.request("/v1/contacts", { method: "DELETE" });
createDaykeeperWebClient({
  baseUrl: "https://support.example.com",
  // @ts-expect-error There is no admin credential option.
  apiKey: "not-a-browser-option",
});
export type { Identity, Conversations, NoLifecycle, NoErasure };
