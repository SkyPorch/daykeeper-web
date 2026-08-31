import daykeeper = require("@skyporch/daykeeper-web");
const client: daykeeper.DaykeeperWebClient = daykeeper.createDaykeeperWebClient(
  {
    baseUrl: "https://support.example.com",
    getAccessToken: () => "synthetic-customer-token",
  },
);
const result: Promise<daykeeper.DaykeeperUnreadSummary> = client.getUnread();
void result;
