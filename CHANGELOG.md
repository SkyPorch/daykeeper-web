# Changelog

## 0.1.0

- Preserve reverse-proxy path prefixes and retry exactly once with a forced
  token refresh after an HTTP 401 response.

- Add typed customer identity, conversation, message, unread, and seen APIs.
- Add safe anonymous-thread claiming after sign-in.
- Add bounded response parsing, rotating tokens, request timeouts, and stable
  customer-safe errors.
