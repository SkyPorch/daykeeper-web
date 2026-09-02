# Contributing

Customer API changes start in `SkyPorch/daykeeper-openapi`. Update the vendored
tagged contract, regenerate types, and keep ergonomic methods as thin wrappers
over stable OpenAPI operation identifiers.

This SDK runs in a browser and takes only short-lived, tenant-bound end-user
tokens. It must never accept administrative credentials. Add transport tests
for retries, timeouts, aborts, response limits, and error envelopes.

Examples, fixtures, and documentation must stay synthetic: no real tenant
names, customer data, hostnames, or downstream product names.

Run the repository's checks before requesting review.
