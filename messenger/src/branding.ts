/** Where the footer's "Powered by Daykeeper" link lands. */
export const POWERED_BY_PAGE = "https://www.mydaykeeper.com/widget";

/**
 * The footer link, tagged so the website can tell a widget referral apart
 * and see which site it came from: `ref=widget`, the embedding page's host as
 * `utm_source`, and the same medium and campaign the Chatwoot widget's footer
 * sends. The link opens with `noreferrer`, so these tags are the only record
 * of where the visit came from.
 */
export function poweredByUrl(hostname: string): string {
  const url = new URL(POWERED_BY_PAGE);
  url.searchParams.set("ref", "widget");
  if (hostname) {
    url.searchParams.set("utm_source", hostname);
  }
  url.searchParams.set("utm_medium", "widget");
  url.searchParams.set("utm_campaign", "branding");
  return url.toString();
}
