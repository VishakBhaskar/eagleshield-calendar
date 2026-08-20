// Next's standalone launcher changes into its own directory. Worker threads share
// a process-wide cwd and Node intentionally disallows chdir inside a worker; the
// test already starts from the project root, so the launcher's chdir is redundant.
process.chdir = () => {};
await import("../../.next/standalone/server.js");
