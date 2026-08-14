import assert from "node:assert/strict";
import test from "node:test";

import {
  generateRandomBank,
} from "../app/shapeshifter-core.ts";

test("generated wavetable sets remain finite and vary substantially between waves", () => {
  let state = 123456789;
  const random = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 4294967296);
  const bank = generateRandomBank(random);
  assert.equal(bank.length, 8);
  assert.ok(bank.every((wave) => wave.length === 512));
  assert.ok(bank.every((wave) => [...wave].every((value) => Number.isFinite(value) && Math.abs(value) <= 1)));
  const averageMovement = bank.slice(1).reduce((sum, wave, index) =>
    sum + wave.reduce((difference, value, sample) => difference + Math.abs(value - bank[index][sample]), 0) / wave.length, 0) / 7;
  assert.ok(averageMovement > 0.25, `expected a varied morph, received ${averageMovement}`);
});
