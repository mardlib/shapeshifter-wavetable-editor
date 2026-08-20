import assert from "node:assert/strict";
import test from "node:test";

import {
  FIRMWARE_SIZE,
  extractFirmwareImage,
  generateRandomBank,
} from "../app/shapeshifter-core.ts";
import type { FirmwareImage } from "../app/shapeshifter-core.ts";
import {
  EPCS16_FLASH_SIZE,
  FLASH_SECTOR_SIZE,
  flashSizeForEpcsSiliconId,
  PHYSICAL_FLASH_SIZE,
  restoreFullFlashBackup,
  runSafeFirmwareUpdate,
} from "../app/firmware-update.ts";
import { usbBlasterReadRequestLength } from "../app/usb-blaster-core.ts";

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

function jicImage(bytes: Uint8Array, programmedSectors: number[]): FirmwareImage {
  return { bytes, format: "JIC", programmedSectors };
}

test("USB-Blaster reads always reserve complete 64-byte FTDI packets", () => {
  assert.equal(usbBlasterReadRequestLength(1), 64);
  assert.equal(usbBlasterReadRequestLength(4), 64);
  assert.equal(usbBlasterReadRequestLength(62), 64);
  assert.equal(usbBlasterReadRequestLength(63), 128);
});

test("detects older 2 MB and newer 8 MB DE0-Nano flash chips", () => {
  assert.equal(flashSizeForEpcsSiliconId(0x14), EPCS16_FLASH_SIZE);
  assert.equal(flashSizeForEpcsSiliconId(0x16), PHYSICAL_FLASH_SIZE);
  assert.throws(() => flashSizeForEpcsSiliconId(0x15), /Unsupported flash chip/);
});

class FakeFlash {
  bytes: Uint8Array;
  writes = 0;
  reads = 0;
  restarts = 0;
  corruptReadNumber = 0;
  failWriteNumber = 0;
  restartError = false;

  constructor(initial: Uint8Array) {
    this.bytes = new Uint8Array(initial);
  }

  async readFlash(address: number, length: number, onProgress?: (fraction: number) => void) {
    this.reads++;
    const result = this.bytes.slice(address, address + length);
    if (this.reads === this.corruptReadNumber) result[12345] ^= 0xff;
    onProgress?.(1);
    return result;
  }

  async writeFlashSector(address: number, data: Uint8Array, onProgress?: (fraction: number) => void) {
    this.writes++;
    this.bytes.set(data, address);
    if (this.writes === this.failWriteNumber) throw new Error("simulated sector write failure");
    onProgress?.(1);
  }

  async restartFromFlash() {
    this.restarts++;
    if (this.restartError) throw new Error("restart transport lost");
  }
}

test("extracts a complete EPCS16 image from a validated Shapeshifter JIC", () => {
  const result = extractFirmwareImage(makeJic());
  assert.equal(result.format, "JIC");
  assert.equal(result.bytes.length, FIRMWARE_SIZE);
  assert.equal(result.bytes[257], 128);
  assert.equal(result.programmedSectors.length, 32);
});

test("JIC extraction treats fully blank sectors as unassigned", () => {
  const source = makeJic();
  const imageStart = 0x9b;
  source.fill(0xff, imageStart + 0x0b0000, imageStart + 0x0f0000);
  const result = extractFirmwareImage(source);
  assert.deepEqual(result.programmedSectors.slice(9, 13), [9, 10, 15, 16]);
  assert.ok(!result.programmedSectors.some((sector) => sector >= 11 && sector <= 14));
});

test("rejects a JIC that does not identify the Shapeshifter FPGA", () => {
  const source = makeJic();
  source.fill(0, 32, 40);
  assert.throws(() => extractFirmwareImage(source), /EP4CE22/);
});

test("safe update persists the old flash, verifies against the new image, then restarts", async () => {
  const original = new Uint8Array(PHYSICAL_FLASH_SIZE).fill(0x31);
  original.fill(0x5c, FIRMWARE_SIZE);
  const firmware = new Uint8Array(FIRMWARE_SIZE).fill(0xa7);
  const programmedSectors = [0, 15, 16];
  const device = new FakeFlash(original);
  let persisted: Uint8Array | null = null;
  const result = await runSafeFirmwareUpdate(device, jicImage(firmware, programmedSectors), async (bytes) => {
    assert.equal(device.writes, 0, "backup must be persisted before the first write");
    persisted = new Uint8Array(bytes);
  });
  assert.deepEqual(persisted, original);
  assert.deepEqual(result.backup, original);
  assert.equal(result.changed, true);
  const expected = new Uint8Array(original);
  for (const sector of programmedSectors) {
    const start = sector * FLASH_SECTOR_SIZE;
    expected.set(firmware.subarray(start, start + FLASH_SECTOR_SIZE), start);
  }
  assert.deepEqual(device.bytes, expected);
  assert.deepEqual(device.bytes.subarray(FLASH_SECTOR_SIZE, 15 * FLASH_SECTOR_SIZE), original.subarray(FLASH_SECTOR_SIZE, 15 * FLASH_SECTOR_SIZE), "unassigned sectors must remain untouched");
  assert.equal(device.writes, 3);
  assert.equal(device.restarts, 1);
});

test("an already installed FPGA configuration performs no flash write", async () => {
  const original = new Uint8Array(PHYSICAL_FLASH_SIZE).fill(0x29);
  const firmware = new Uint8Array(FIRMWARE_SIZE).fill(0x81);
  const programmedSectors = [0, 15];
  for (const sector of programmedSectors) {
    const start = sector * FLASH_SECTOR_SIZE;
    firmware.set(original.subarray(start, start + FLASH_SECTOR_SIZE), start);
  }
  const device = new FakeFlash(original);
  const result = await runSafeFirmwareUpdate(device, jicImage(firmware, programmedSectors), async (persisted) => {
    persisted.fill(0, 0, FLASH_SECTOR_SIZE);
  });
  assert.equal(result.changed, false);
  assert.equal(device.writes, 0);
  assert.equal(device.restarts, 1);
  assert.deepEqual(device.bytes, original);
});

test("safe update backs up and verifies an older 2 MB flash completely", async () => {
  const original = new Uint8Array(EPCS16_FLASH_SIZE).fill(0x24);
  const firmware = new Uint8Array(FIRMWARE_SIZE).fill(0x91);
  const device = new FakeFlash(original);
  const result = await runSafeFirmwareUpdate(
    device,
    jicImage(firmware, [0, 15]),
    async () => {},
    undefined,
    EPCS16_FLASH_SIZE,
  );
  assert.equal(result.backup.length, EPCS16_FLASH_SIZE);
  assert.equal(device.bytes.length, EPCS16_FLASH_SIZE);
  assert.equal(device.writes, 2);
  assert.equal(device.restarts, 1);
});

test("update verify failure restores and verifies the original full flash", async () => {
  const original = new Uint8Array(PHYSICAL_FLASH_SIZE).fill(0x42);
  const firmware = new Uint8Array(FIRMWARE_SIZE).fill(0x99);
  const programmedSectors = [0, 15, 16];
  const device = new FakeFlash(original);
  device.corruptReadNumber = 3;
  await assert.rejects(
    runSafeFirmwareUpdate(device, jicImage(firmware, programmedSectors), async () => {}),
    /original full-flash backup was automatically restored and verified/,
  );
  assert.deepEqual(device.bytes, original);
  assert.equal(device.writes, 35);
  assert.equal(device.restarts, 1, "restart is allowed only after rollback verification succeeds");
});

test("sector write failure restores and verifies the original full flash", async () => {
  const original = new Uint8Array(PHYSICAL_FLASH_SIZE).fill(0x63);
  const firmware = new Uint8Array(FIRMWARE_SIZE).fill(0xbc);
  const programmedSectors = [0, 15, 16];
  const device = new FakeFlash(original);
  device.failWriteNumber = 2;
  await assert.rejects(
    runSafeFirmwareUpdate(device, jicImage(firmware, programmedSectors), async () => {}),
    /original full-flash backup was automatically restored and verified/,
  );
  assert.deepEqual(device.bytes, original);
  assert.equal(device.writes, 34);
  assert.equal(device.restarts, 1);
});

test("backup persistence failure leaves flash untouched and does not restart", async () => {
  const original = new Uint8Array(PHYSICAL_FLASH_SIZE).fill(0x55);
  const firmware = new Uint8Array(FIRMWARE_SIZE).fill(0xaa);
  const device = new FakeFlash(original);
  await assert.rejects(
    runSafeFirmwareUpdate(device, jicImage(firmware, [0]), async () => { throw new Error("save canceled"); }),
    /save canceled/,
  );
  assert.equal(device.writes, 0);
  assert.equal(device.restarts, 0);
  assert.deepEqual(device.bytes, original);
});

test("restart failure after successful firmware verification does not trigger rollback", async () => {
  const original = new Uint8Array(PHYSICAL_FLASH_SIZE).fill(0x26);
  const firmware = new Uint8Array(FIRMWARE_SIZE).fill(0xd4);
  const programmedSectors = [0, 15, 16];
  const device = new FakeFlash(original);
  device.restartError = true;
  await assert.rejects(
    runSafeFirmwareUpdate(device, jicImage(firmware, programmedSectors), async () => {}),
    /JIC programming target passed complete byte-for-byte verification, but restart failed/,
  );
  const expected = new Uint8Array(original);
  for (const sector of programmedSectors) {
    const start = sector * FLASH_SECTOR_SIZE;
    expected.set(firmware.subarray(start, start + FLASH_SECTOR_SIZE), start);
  }
  assert.deepEqual(device.bytes, expected);
  assert.equal(device.writes, 3, "a post-verification restart error must not rewrite the flash");
  assert.equal(device.restarts, 1);
});

test("manual recovery verifies against the selected backup, never a firmware image", async () => {
  const backup = new Uint8Array(PHYSICAL_FLASH_SIZE).fill(0x17);
  const device = new FakeFlash(new Uint8Array(PHYSICAL_FLASH_SIZE).fill(0xe8));
  device.bytes.set(backup.subarray(FIRMWARE_SIZE), FIRMWARE_SIZE);
  await restoreFullFlashBackup(device, backup);
  assert.deepEqual(device.bytes, backup);
  assert.equal(device.writes, 32);
  assert.equal(device.restarts, 1);
});

test("manual recovery does not restart when full readback differs from its backup", async () => {
  const backup = new Uint8Array(PHYSICAL_FLASH_SIZE).fill(0x7a);
  const device = new FakeFlash(new Uint8Array(PHYSICAL_FLASH_SIZE).fill(0x08));
  device.bytes.set(backup.subarray(FIRMWARE_SIZE), FIRMWARE_SIZE);
  device.corruptReadNumber = 1;
  await assert.rejects(restoreFullFlashBackup(device, backup), /does not match the original full-flash backup/);
  assert.equal(device.restarts, 0);
});

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
