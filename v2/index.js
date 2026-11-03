// OpenCode 2 loads a configured local plugin as a directory and imports its
// index server entry. This directory exists so the bridge has that shape; the
// implementation stays in dist, which is the one build both runtimes load.
export { default } from "../dist/doppler.js";
