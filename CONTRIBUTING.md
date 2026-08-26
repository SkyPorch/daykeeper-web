# Contributing

Customer API changes start in `SkyPorch/daykeeper-openapi`. Update the vendored
tagged contract and regenerate with `pnpm generate`.

Run `pnpm check` before review. Browser behavior must keep administrative
credentials out of the bundle, fetch a fresh end-user token per request, enforce
bounded responses, and avoid logging tokens or conversation contents.
