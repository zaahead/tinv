// cli/pipeline.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldChunk, segmentCount } from "./pipeline.js";

test("shouldChunk only above the min-split duration", () => {
  assert.equal(shouldChunk(120, 60), true);
  assert.equal(shouldChunk(60, 60), true);
  assert.equal(shouldChunk(59, 60), false);
  assert.equal(shouldChunk(0, 60), false);
});

test("segmentCount is ceil(duration/segLen), at least 1", () => {
  assert.equal(segmentCount(90, 30), 3);
  assert.equal(segmentCount(91, 30), 4);
  assert.equal(segmentCount(10, 30), 1);
  assert.equal(segmentCount(0, 30), 1);
});
