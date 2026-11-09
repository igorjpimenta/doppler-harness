// A configured local plugin resolves as a directory: package.json exports
// first, or an index at the root. This is that entry. The built bridge stays
// in dist/, so both runtimes load the same file.
export { default } from "./dist/doppler.js";
