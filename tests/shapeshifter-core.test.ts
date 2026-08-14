import assert from "node:assert/strict";
import test from "node:test";

import {
  FIRMWARE_SIZE,
  extractFirmwareImage,
  generateRandomBank,
} from "../app/shapeshifter-core.ts";

function makeJic() {
  const headerSize = 0x9b;
  const source = new Uint8Array(headerSize + FIRMWARE_SIZE + 2);
  source.set(new TextEncoder().encode("JIC\0"), 0);
  source.set(new TextEncoder().encode("Quartus Prime"), 8);
  source.set(new TextEncoder().encode("EP4CE22"), 32);
  source.set(new TextEncoder().encode("EPCS16"), 48);
  const view = new DataView(source.buffer);
  view.setUint16(0x89, 0x001c, true);
  view.setUint32(0x8b, FIRMWARE_SIZE + 12, true);
  for (let index = 0; index < FIRMWARE_SIZE; index++) source[headerSize + index] = index & 0xff;
  view.setUint16(headerSize + FIRMWARE_SIZE, 0x001e, true);
  return source;
}

test("extracts a complete EPCS16 image from a validated Shapeshifter JIC", () => {
  const result = extractFirmwareImage(makeJic());
  assert.equal(result.format, "JIC");
  assert.equal(result.bytes.length, FIRMWARE_SIZE);
  assert.equal(result.bytes[0], 0);
  assert.equal(result.bytes[257], 1);
});

test("rejects a JIC that does not identify the Shapeshifter FPGA", () => {
  const source = makeJic();
  source.fill(0, 32, 40);
  assert.throws(() => extractFirmwareImage(source), /EP4CE22/);
});

test("wild random banks remain finite and vary substantially between waves", () => {
  let state = 123456789;
  const random = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 4294967296);
  const bank = generateRandomBank(random);
  assert.equal(bank.length, 8);
  assert.ok(bank.every((wave) => wave.length === 512));
  assert.ok(bank.every((wave) => [...wave].every((value) => Number.isFinite(value) && Math.abs(value) <= 1)));
  const averageMovement = bank.slice(1).reduce((sum, wave, index) =>
    sum + wave.reduce((difference, value, sample) => difference + Math.abs(value - bank[index][sample]), 0) / wave.length, 0) / 7;
  assert.ok(averageMovement > 0.25, `expected a wild morph, received ${averageMovement}`);
});
