"use strict";

// The limits pr-review-cli.yml's chunk machinery is tested at: the files per
// chunk, the bytes per chunk and the chunk ceiling it was built for. The
// workflow's env sets MAX_CHUNKS to 1, so no review is chunked; setting these
// three values there chunks a large diff again, and these tests keep that
// path checked.
const CHUNK_MACHINERY_LIMITS = Object.freeze({
  MAX_CHUNK_FILES: "40",
  READ_BUDGET: "300000",
  MAX_CHUNKS: "20",
});

// Puts CHUNK_MACHINERY_LIMITS in a parsed workflow's `env`, so every test
// that reads or spreads it runs the chunk machinery, and returns the
// workflow's own values of those limits for the tests of one review.
function atChunkMachineryLimits(env) {
  const shipped = Object.freeze(
    Object.fromEntries(
      Object.keys(CHUNK_MACHINERY_LIMITS).map((name) => [name, env[name]]),
    ),
  );
  Object.assign(env, CHUNK_MACHINERY_LIMITS);
  return shipped;
}

module.exports = { CHUNK_MACHINERY_LIMITS, atChunkMachineryLimits };
