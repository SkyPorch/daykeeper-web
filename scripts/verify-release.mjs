// Intentionally fail closed even if a caller toggles package.json.private.
// A maintainer must review and replace this bootstrap gate in a release PR.
console.error(
  "Daykeeper Web publication is disabled. Complete RELEASING.md and obtain maintainer approval before changing this gate.",
);
process.exitCode = 1;
