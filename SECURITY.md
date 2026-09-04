# Security

Do not open public issues for vulnerabilities or include credentials, customer
data, or tenant identifiers in reports. Contact SkyPorch privately with the
affected version, synthetic reproduction steps, and impact. No public package
version is currently supported; this foundation is unreleased and unpublished.

## How to report

Use GitHub's private vulnerability reporting on this repository: open the
**Security** tab and choose **Report a vulnerability**. If that is unavailable
to you, contact the SkyPorch maintainers privately through your existing
SkyPorch support channel. Do not open a public issue.

## What to expect

- Acknowledgement within 3 business days.
- A status update at least every 7 days while the report is open.
- Coordinated disclosure within 90 days of the report, or sooner once a fix
  ships. Tell us if you intend to publish earlier so a fix can be prepared.

## Security model

The SDK accepts a short-lived customer-token provider, never an administrative
API key interface. It has no persistence, telemetry, cookie authentication, or
background delivery. Configure the gateway from trusted application settings;
a visitor-controlled HTTPS URL can still be an attacker-controlled origin.

The server must enforce tenant/customer/scope/expiry and conversation ownership.
Frontend types and CORS do not establish those permissions. The current gateway
Origin/error-CORS integration gates are documented in COMPATIBILITY.md.

Raw provider/network errors, arbitrary gateway error text, response bodies,
headers, and abort reasons are not included in SDK errors. Successful responses
contain customer data: do not log tokens, identities, message contents, or
anonymous widget tokens. Do not render response text as unsanitized HTML.

Abort pending requests and discard the application's in-memory token cache on
sign-out or identity change. No cancellation guarantees that an already
accepted write was undone. Reconcile unknown outcomes before manually retrying.

The test harness uses local synthetic fixtures and a fresh temporary browser
profile. Never replace its fixture values with real customer or management
credentials, and do not upload generated profiles or logs as public artifacts.
