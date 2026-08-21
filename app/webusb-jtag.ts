// Minimal WebUSB/USB-Blaster JTAG transport for the WavePort read-only backup flow.
// The Altera programming and SPI-over-JTAG sequences follow openFPGALoader
// (Apache-2.0); see THIRD_PARTY_NOTICES.md.

/* eslint-disable @typescript-eslint/no-explicit-any -- WebUSB is not part of the standard TypeScript DOM declarations. */

import { usbBlasterReadRequestLength } from "./usb-blaster-core";

export const SHAPESHIFTER_IDCODE = 0x020f30dd;

type TapState =
  | "reset" | "idle"
  | "select-dr" | "capture-dr" | "shift-dr" | "exit1-dr" | "pause-dr" | "exit2-dr" | "update-dr"
  | "select-ir" | "capture-ir" | "shift-ir" | "exit1-ir" | "pause-ir" | "exit2-ir" | "update-ir";

const TAP: Record<TapState, [TapState, TapState]> = {
  reset: ["idle", "reset"], idle: ["idle", "select-dr"],
  "select-dr": ["capture-dr", "select-ir"], "capture-dr": ["shift-dr", "exit1-dr"],
  "shift-dr": ["shift-dr", "exit1-dr"], "exit1-dr": ["pause-dr", "update-dr"],
  "pause-dr": ["pause-dr", "exit2-dr"], "exit2-dr": ["shift-dr", "update-dr"],
  "update-dr": ["idle", "select-dr"], "select-ir": ["capture-ir", "reset"],
  "capture-ir": ["shift-ir", "exit1-ir"], "shift-ir": ["shift-ir", "exit1-ir"],
  "exit1-ir": ["pause-ir", "update-ir"], "pause-ir": ["pause-ir", "exit2-ir"],
  "exit2-ir": ["shift-ir", "update-ir"], "update-ir": ["idle", "select-dr"],
};

const DEFAULT_PINS = 0x2c;
const DO_READ = 0x40;
const DO_SHIFT = 0x80;

function reverseByte(value: number) {
  value = ((value & 0xf0) >>> 4) | ((value & 0x0f) << 4);
  value = ((value & 0xcc) >>> 2) | ((value & 0x33) << 2);
  return (((value & 0xaa) >>> 1) | ((value & 0x55) << 1)) & 0xff;
}

function pathBetween(from: TapState, to: TapState) {
  if (from === to) return [];
  const queue: Array<{ state: TapState; path: number[] }> = [{ state: from, path: [] }];
  const seen = new Set<TapState>([from]);
  while (queue.length) {
    const current = queue.shift()!;
    for (const tms of [0, 1] as const) {
      const next = TAP[current.state][tms];
      const path = [...current.path, tms];
      if (next === to) return path;
      if (!seen.has(next)) { seen.add(next); queue.push({ state: next, path }); }
    }
  }
  throw new Error(`No TAP path from ${from} to ${to}.`);
}

function stripFtdiStatus(view: DataView) {
  const raw = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  const payload: number[] = [];
  for (let start = 0; start < raw.length; start += 64) {
    for (let i = start + 2; i < Math.min(start + 64, raw.length); i++) payload.push(raw[i]);
  }
  return payload;
}

export class UsbBlasterJtag {
  private state: TapState = "reset";

  constructor(
    private device: any,
    private inEndpoint: number,
    private outEndpoint: number,
  ) {}

  async initialize() {
    const setup = async (request: number, value: number) => {
      const result = await this.device.controlTransferOut({
        requestType: "vendor", recipient: "device", request, value, index: 1,
      });
      if (result.status !== "ok") throw new Error(`FTDI initialization ${request}: ${result.status}`);
    };
    await setup(0, 0);
    await setup(0, 1);
    await setup(0, 2);
    await setup(9, 2);
    await setup(11, 0);

    // Match the USB-Blaster I driver: clock TMS high long enough to clear any
    // stale FT245/JTAG state, then establish a known TAP state.
    const clear = new Uint8Array(4096);
    for (let i = 0; i < clear.length; i += 2) { clear[i] = 0x2e; clear[i + 1] = 0x2f; }
    await this.write(clear);
    this.state = "reset";
    await this.resetTap();
  }

  async resetTap() {
    await this.clockTms([1, 1, 1, 1, 1, 0]);
    this.state = "idle";
  }

  private async write(bytes: Uint8Array) {
    const result = await this.device.transferOut(this.outEndpoint, bytes);
    if (result.status !== "ok") throw new Error(`USB-Blaster output: ${result.status}`);
  }

  private async readPayload(length: number) {
    const payload: number[] = [];
    let attempts = 0;
    while (payload.length < length && attempts++ < 2000) {
      const remaining = length - payload.length;
      const requestLength = usbBlasterReadRequestLength(remaining);
      const result = await Promise.race([
        this.device.transferIn(this.inEndpoint, requestLength),
        new Promise<never>((_, reject) => window.setTimeout(
          () => reject(new Error("USB-Blaster timed out. Reload the page and restart the module.")),
          5000,
        )),
      ]);
      if (result.status !== "ok" || !result.data) throw new Error(`USB-Blaster readback: ${result.status}`);
      payload.push(...stripFtdiStatus(result.data));
    }
    if (payload.length < length) throw new Error(`Incomplete JTAG readback (${payload.length}/${length}).`);
    return new Uint8Array(payload.slice(0, length));
  }

  private isRecoverableTransferInError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return /transferIn.*transfer error|transfer error.*transferIn/i.test(message);
  }

  private async recoverTransferIn() {
    // Discard any incomplete FTDI packet before repeating the complete flash
    // read command. Continuing inside a failed packet could shift every byte.
    const purge = await this.device.controlTransferOut({
      requestType: "vendor", recipient: "device", request: 0, value: 1, index: 1,
    });
    if (purge.status !== "ok") throw new Error(`FTDI receive-buffer recovery: ${purge.status}`);
    this.state = "reset";
    await this.resetTap();
  }

  private async clockTms(bits: number[]) {
    if (!bits.length) return;
    const commands: number[] = [];
    for (const bit of bits) {
      const pins = DEFAULT_PINS | 0x10 | (bit ? 0x02 : 0);
      commands.push(pins, pins | 0x01);
      this.state = TAP[this.state][bit as 0 | 1];
    }
    commands.push(DEFAULT_PINS | (bits.at(-1) ? 0x02 : 0));
    await this.write(new Uint8Array(commands));
  }

  async setState(target: TapState) {
    await this.clockTms(pathBetween(this.state, target));
  }

  async toggleClocks(count: number) {
    await this.setState("idle");
    const zeroes = new Uint8Array(63);
    while (count >= 8) {
      const bytes = Math.min(63, count >>> 3);
      await this.write(new Uint8Array([DO_SHIFT | bytes, ...zeroes.subarray(0, bytes)]));
      count -= bytes * 8;
    }
    if (count) await this.clockTms(new Array(count).fill(0));
  }

  private async shiftBytes(data: Uint8Array | null, byteLength: number, read: boolean) {
    const result = read ? new Uint8Array(byteLength) : null;
    let offset = 0;
    while (offset < byteLength) {
      const batchStart = offset;
      const commands: number[] = [];
      // Queue the USB read before submitting batched shift commands. This lets
      // the host drain the small FT245 receive FIFO while JTAG data arrives.
      const commandBudget = 12000;
      while (offset < byteLength && commands.length < commandBudget) {
        const length = Math.min(63, byteLength - offset);
        commands.push(DO_SHIFT | (read ? DO_READ : 0) | length);
        if (data) commands.push(...data.subarray(offset, offset + length));
        else for (let i = 0; i < length; i++) commands.push(0);
        offset += length;
      }
      if (result) {
        const readPromise = this.readPayload(offset - batchStart);
        const [, payload] = await Promise.all([this.write(new Uint8Array(commands)), readPromise]);
        result.set(payload, batchStart);
      } else {
        await this.write(new Uint8Array(commands));
      }
    }
    return result;
  }

  private async shiftBits(data: Uint8Array | null, bitLength: number, read: boolean, end: boolean) {
    const effective = end ? bitLength - 1 : bitLength;
    const wholeBytes = effective >>> 3;
    const remainingBits = effective & 7;
    const output = read ? new Uint8Array(Math.ceil(bitLength / 8)) : null;
    if (wholeBytes) {
      const bytes = await this.shiftBytes(data, wholeBytes, read);
      if (output && bytes) output.set(bytes);
    }
    const bitOffset = wholeBytes * 8;
    const tailCount = remainingBits + (end ? 1 : 0);
    if (tailCount) {
      const commands: number[] = [];
      for (let i = 0; i < tailCount; i++) {
        const isLast = end && i === tailCount - 1;
        const sourceBit = bitOffset + i;
        const tdi = data && (data[sourceBit >>> 3] & (1 << (sourceBit & 7))) ? 0x10 : 0;
        const pins = DEFAULT_PINS | tdi | (isLast ? 0x02 : 0);
        commands.push(pins, pins | 0x01 | (read ? DO_READ : 0));
      }
      await this.write(new Uint8Array(commands));
      if (read && output) {
        const raw = await this.readPayload(tailCount);
        for (let i = 0; i < tailCount; i++) if (raw[i] & 1) output[(bitOffset + i) >>> 3] |= 1 << ((bitOffset + i) & 7);
      }
    }
    return output;
  }

  async shiftIr(data: Uint8Array, bitLength: number, endState: TapState = "idle") {
    await this.setState("shift-ir");
    await this.shiftBits(data, bitLength, false, endState !== "shift-ir");
    if (endState !== "shift-ir") { this.state = "exit1-ir"; await this.setState(endState); }
  }

  async shiftDr(data: Uint8Array | null, bitLength: number, read = false, endState: TapState = "idle") {
    await this.setState("shift-dr");
    const result = await this.shiftBits(data, bitLength, read, endState !== "shift-dr");
    if (endState !== "shift-dr") { this.state = "exit1-dr"; await this.setState(endState); }
    return result;
  }

  async readIdCode() {
    await this.resetTap();
    await this.shiftIr(new Uint8Array([0x06, 0]), 10);
    const bytes = await this.shiftDr(new Uint8Array(4), 32, true);
    return new DataView(bytes!.buffer).getUint32(0, true);
  }

  async loadSpiBridge(rbf: Uint8Array, onProgress?: (fraction: number) => void) {
    await this.shiftIr(new Uint8Array([0x02, 0]), 10, "pause-ir");
    await this.toggleClocks(24000);

    await this.setState("shift-dr");
    const chunkSize = 32768;
    for (let offset = 0; offset < rbf.length; offset += chunkSize) {
      const end = Math.min(rbf.length, offset + chunkSize);
      const last = end === rbf.length;
      await this.shiftBits(rbf.subarray(offset, end), (end - offset) * 8, false, last);
      if (last) this.state = "exit1-dr";
      onProgress?.(end / rbf.length);
    }

    await this.shiftIr(new Uint8Array([0x04, 0]), 10, "pause-ir");
    await this.toggleClocks(120);
    await this.shiftDr(new Uint8Array(108), 864, false, "idle");
    await this.shiftIr(new Uint8Array([0x03, 0]), 10, "pause-ir");
    await this.toggleClocks(98391);
    await this.toggleClocks(512);
    await this.shiftIr(new Uint8Array([0xff, 0x03]), 10, "pause-ir");
    await this.toggleClocks(24000);
  }

  private async shiftVir(value: number) {
    const virtualInstruction = 0x1000 | (value & 0x3fff);
    await this.shiftIr(new Uint8Array([0x0e, 0]), 10, "update-ir");
    await this.shiftDr(new Uint8Array([virtualInstruction & 0xff, virtualInstruction >>> 8]), 14, false, "update-dr");
  }

  private async shiftVdr(data: Uint8Array | null, bitLength: number, read: boolean) {
    await this.shiftIr(new Uint8Array([0x0c, 0]), 10, "update-ir");
    return this.shiftDr(data, bitLength, read, "idle");
  }

  private async spiTransfer(command: number, tx = new Uint8Array(), readLength = 0) {
    const payloadLength = Math.max(tx.length, readLength);
    const transferLength = payloadLength + 1 + (readLength ? 1 : 0);
    const wire = new Uint8Array(transferLength);
    for (let i = 0; i < tx.length; i++) wire[i] = reverseByte(tx[i]);
    await this.shiftVir(reverseByte(command));
    const raw = await this.shiftVdr(wire, wire.length * 8, readLength > 0);
    if (!readLength) return new Uint8Array();
    const decoded = new Uint8Array(payloadLength);
    for (let i = 0; i < payloadLength; i++) {
      decoded[i] = reverseByte(raw![i + 1] >>> 1) | (raw![i + 2] & 1);
    }
    return decoded.subarray(0, readLength);
  }

  private async waitFlashReady(timeoutMs: number) {
    const started = performance.now();
    while (performance.now() - started < timeoutMs) {
      const status = (await this.spiTransfer(0x05, new Uint8Array(1), 1))[0];
      if ((status & 0x01) === 0) return;
      await new Promise((resolve) => window.setTimeout(resolve, 5));
    }
    throw new Error("Timed out: EPCS flash remains busy.");
  }

  private async writeEnable() {
    await this.spiTransfer(0x06);
    const status = (await this.spiTransfer(0x05, new Uint8Array(1), 1))[0];
    if ((status & 0x02) === 0) throw new Error("EPCS flash did not confirm Write Enable.");
  }

  async readFlash(address: number, length: number, onProgress?: (fraction: number) => void) {
    const chunkSize = 1024;
    const output = new Uint8Array(length);
    for (let offset = 0; offset < length; offset += chunkSize) {
      const count = Math.min(chunkSize, length - offset);
      const currentAddress = address + offset;
      const commandData = new Uint8Array(count + 5);
      commandData[0] = reverseByte((currentAddress >>> 16) & 0xff);
      commandData[1] = reverseByte((currentAddress >>> 8) & 0xff);
      commandData[2] = reverseByte(currentAddress & 0xff);
      let raw: Uint8Array | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await this.shiftVir(reverseByte(0x03));
          raw = await this.shiftVdr(commandData, commandData.length * 8, true);
          break;
        } catch (error) {
          if (attempt === 2 || !this.isRecoverableTransferInError(error)) throw error;
          await this.recoverTransferIn();
        }
      }
      if (!raw) throw new Error(`Flash read failed at address 0x${currentAddress.toString(16)}.`);
      for (let i = 0; i < count; i++) {
        output[offset + i] = reverseByte(raw[i + 4] >>> 1) | (raw[i + 5] & 1);
      }
      onProgress?.((offset + count) / length);
    }
    return output;
  }

  async readEpcsSiliconId() {
    // EPCS1/4/16/64: 0xAB followed by three dummy bytes, then the ID.
    const ids: number[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await this.spiTransfer(0xab, new Uint8Array(4), 4);
      ids.push(response[3]);
    }
    if (!ids.every((id) => id === ids[0])) {
      throw new Error(`Unstable EPCS silicon ID reads: ${ids.map((id) => `0x${id.toString(16).padStart(2, "0")}`).join(", ")}.`);
    }
    return ids[0];
  }

  async writeFlashSector(address: number, data: Uint8Array, onProgress?: (fraction: number) => void) {
    if ((address & 0xffff) !== 0 || data.length !== 0x10000) {
      throw new Error("Sector access must be exactly 64 KB and aligned.");
    }
    const addressBytes = new Uint8Array([(address >>> 16) & 0xff, (address >>> 8) & 0xff, address & 0xff]);
    await this.writeEnable();
    await this.spiTransfer(0xd8, addressBytes);
    await this.waitFlashReady(8000);
    onProgress?.(0.08);

    for (let offset = 0; offset < data.length; offset += 256) {
      const pageAddress = address + offset;
      const payload = new Uint8Array(3 + 256);
      payload[0] = (pageAddress >>> 16) & 0xff;
      payload[1] = (pageAddress >>> 8) & 0xff;
      payload[2] = pageAddress & 0xff;
      payload.set(data.subarray(offset, offset + 256), 3);
      await this.writeEnable();
      await this.spiTransfer(0x02, payload);
      await this.waitFlashReady(1000);
      onProgress?.(0.08 + ((offset + 256) / data.length) * 0.92);
    }
  }

  async restartFromFlash() {
    await this.setState("reset");
    await this.shiftIr(new Uint8Array([0x01, 0]), 10);
    await this.toggleClocks(1);
    await this.resetTap();
  }
}

export function formatIdCode(value: number) {
  return `0x${value.toString(16).toUpperCase().padStart(8, "0")}`;
}

export function expectedShapeshifter(value: number) {
  return value === SHAPESHIFTER_IDCODE;
}
