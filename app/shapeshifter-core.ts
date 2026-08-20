export const FIRMWARE_SIZE = 2 * 1024 * 1024;
export const BANK_COUNT = 128;
export const WAVES_PER_BANK = 8;
export const SAMPLES_PER_WAVE = 512;
export const BYTES_PER_SAMPLE = 2;
export const BANK_BYTES = WAVES_PER_BANK * SAMPLES_PER_WAVE * BYTES_PER_SAMPLE;

export type WaveBank = Float32Array[];

export type FirmwareImage = {
  bytes: Uint8Array;
  format: "BIN" | "JIC";
  /** Flash sectors explicitly carrying data in the programming file. */
  programmedSectors: number[];
};

const FIRMWARE_SECTOR_SIZE = 0x10000;

function populatedSectors(bytes: Uint8Array) {
  const sectors: number[] = [];
  for (let sector = 0; sector < bytes.length / FIRMWARE_SECTOR_SIZE; sector++) {
    const start = sector * FIRMWARE_SECTOR_SIZE;
    const end = start + FIRMWARE_SECTOR_SIZE;
    for (let offset = start; offset < end; offset++) {
      if (bytes[offset] !== 0xff) {
        sectors.push(sector);
        break;
      }
    }
  }
  return sectors;
}

function containsAscii(source: Uint8Array, text: string, end = source.length): boolean {
  const needle = new TextEncoder().encode(text);
  const limit = Math.min(end, source.length) - needle.length;
  for (let offset = 0; offset <= limit; offset++) {
    let matches = true;
    for (let index = 0; index < needle.length; index++) {
      if (source[offset + index] !== needle[index]) { matches = false; break; }
    }
    if (matches) return true;
  }
  return false;
}

function reverseBits(value: number): number {
  let reversed = 0;
  for (let bit = 0; bit < 8; bit++) reversed = (reversed << 1) | ((value >>> bit) & 1);
  return reversed;
}

/** Extract the EPCS16 image from a Quartus JIC and convert it to flash byte order. */
export function extractFirmwareImage(source: Uint8Array): FirmwareImage {
  if (source.byteLength === FIRMWARE_SIZE) {
    return {
      bytes: new Uint8Array(source),
      format: "BIN",
      programmedSectors: Array.from({ length: FIRMWARE_SIZE / FIRMWARE_SECTOR_SIZE }, (_, sector) => sector),
    };
  }

  const headerLimit = Math.min(512, source.length);
  const isJic = source.length > FIRMWARE_SIZE
    && source[0] === 0x4a && source[1] === 0x49 && source[2] === 0x43 && source[3] === 0x00;
  if (!isJic) throw new Error("Expected an exact 2 MB .bin or a Shapeshifter EPCS16 .jic file.");
  if (!containsAscii(source, "Quartus", headerLimit)
    || !containsAscii(source, "EP4CE22", headerLimit)
    || !containsAscii(source, "EPCS16", headerLimit)) {
    throw new Error("Rejected: the JIC file does not identify a Shapeshifter-compatible EP4CE22 and EPCS16.");
  }

  const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  let imageStart = -1;
  for (let offset = 0; offset + 18 <= headerLimit; offset++) {
    if (view.getUint16(offset, true) !== 0x001c) continue;
    if (view.getUint32(offset + 2, true) !== FIRMWARE_SIZE + 12) continue;
    imageStart = offset + 18;
    break;
  }
  if (imageStart < 0 || imageStart + FIRMWARE_SIZE > source.length) {
    throw new Error("Rejected: the JIC does not contain one complete 2 MB EPCS16 image.");
  }
  const footer = imageStart + FIRMWARE_SIZE;
  if (footer + 2 > source.length || view.getUint16(footer, true) !== 0x001e) {
    throw new Error("Rejected: the JIC payload boundary could not be verified.");
  }
  const bytes = new Uint8Array(FIRMWARE_SIZE);
  for (let index = 0; index < bytes.length; index++) bytes[index] = reverseBits(source[imageStart + index]);
  const programmedSectors = populatedSectors(bytes);
  if (programmedSectors.length === 0) throw new Error("Rejected: the JIC contains no programmable flash sectors.");
  return { bytes, format: "JIC", programmedSectors };
}

export function makeStarterBank(): WaveBank {
  const makers = [
    (p: number) => Math.sin(p * Math.PI * 2),
    (p: number) => 2 * p - 1,
    (p: number) => (p < 0.5 ? 1 : -1),
    (p: number) => 1 - 4 * Math.abs(p - 0.5),
    (p: number) => Math.sin(p * Math.PI * 2) * 0.7 + Math.sin(p * Math.PI * 4) * 0.3,
    (p: number) => Math.sin(p * Math.PI * 2) * 0.55 + Math.sin(p * Math.PI * 6) * 0.3,
    (p: number) => Math.tanh(Math.sin(p * Math.PI * 2) * 2.5),
    (p: number) => Math.sin(p * Math.PI * 2 + Math.sin(p * Math.PI * 4) * 1.5),
  ];
  return makers.map((maker) => {
    const result = new Float32Array(SAMPLES_PER_WAVE);
    for (let i = 0; i < result.length; i++) result[i] = maker(i / result.length);
    return conditionWave(result);
  });
}

export function generateRandomBank(random: () => number = Math.random): WaveBank {
  const harmonicCount = 48;
  const frameCount = 4;
  const phases = Array.from({ length: harmonicCount }, () => random() * Math.PI * 2);
  const spectra = Array.from({ length: frameCount }, () => {
    const decay = 0.35 + random() * 1.25;
    const formant = 3 + random() * 34;
    const width = 1.5 + random() * 8;
    const formantGain = 1.5 + random() * 7;
    const oddGain = 0.25 + random() * 1.75;
    const evenGain = 0.25 + random() * 1.75;
    const combPeriod = 2 + Math.floor(random() * 8);
    const combDepth = 0.25 + random() * 0.7;
    const spectrum = Array.from({ length: harmonicCount }, (_, index) => {
      const harmonic = index + 1;
      const distance = (harmonic - formant) / width;
      const formantShape = 1 + Math.exp(-0.5 * distance * distance) * formantGain;
      const parity = harmonic % 2 ? oddGain : evenGain;
      const comb = harmonic % combPeriod === 0 ? 1 : 1 - combDepth;
      const jagged = 0.15 + random() * 1.85;
      return (formantShape * parity * comb * jagged) / Math.pow(harmonic, decay);
    });
    spectrum[0] = Math.max(0.3, spectrum[0]);
    return spectrum;
  });
  const warpHarmonic = 1 + Math.floor(random() * 7);
  const warpPhase = random() * Math.PI * 2;
  const warpStart = (random() - 0.5) * 1.2;
  const warpEnd = (random() - 0.5) * 2.4;
  const foldStart = 0.7 + random() * 1.4;
  const foldEnd = 1.8 + random() * 5.2;
  const driveStart = 0.7 + random() * 1.3;
  const driveEnd = 1.2 + random() * 3.8;

  return Array.from({ length: WAVES_PER_BANK }, (_, waveIndex) => {
    const linear = waveIndex / (WAVES_PER_BANK - 1);
    const framePosition = linear * (frameCount - 1);
    const leftFrame = Math.min(frameCount - 2, Math.floor(framePosition));
    const frameMixLinear = framePosition - leftFrame;
    const frameMix = frameMixLinear * frameMixLinear * (3 - 2 * frameMixLinear);
    const warp = warpStart * (1 - linear) + warpEnd * linear + Math.sin(linear * Math.PI * 2) * 0.45;
    const fold = foldStart * (1 - linear) + foldEnd * linear;
    const drive = driveStart * (1 - linear) + driveEnd * linear;
    const wave = new Float32Array(SAMPLES_PER_WAVE);
    for (let sample = 0; sample < wave.length; sample++) {
      const phase = (sample / wave.length) * Math.PI * 2;
      const warpedPhase = phase + Math.sin(phase * warpHarmonic + warpPhase) * warp;
      let value = 0;
      for (let harmonic = 1; harmonic <= harmonicCount; harmonic++) {
        const amplitude = spectra[leftFrame][harmonic - 1] * (1 - frameMix)
          + spectra[leftFrame + 1][harmonic - 1] * frameMix;
        value += amplitude * Math.sin(warpedPhase * harmonic + phases[harmonic - 1]);
      }
      const driven = Math.tanh(value * drive);
      const folded = Math.sin(driven * fold * Math.PI);
      wave[sample] = driven * (1 - linear * 0.45) + folded * (linear * 0.45);
    }
    return conditionWave(wave);
  });
}

export function conditionWave(input: Float32Array): Float32Array {
  const out = new Float32Array(input);
  let mean = 0;
  for (const value of out) mean += value;
  mean /= out.length || 1;
  for (let i = 0; i < out.length; i++) out[i] -= mean;

  // Remove the linear endpoint mismatch to reduce clicks at the cycle seam.
  const mismatch = out[out.length - 1] - out[0];
  for (let i = 0; i < out.length; i++) out[i] -= mismatch * (i / (out.length - 1));

  let peak = 0;
  for (const value of out) peak = Math.max(peak, Math.abs(value));
  if (peak > 0) for (let i = 0; i < out.length; i++) out[i] = (out[i] / peak) * 0.98;
  return out;
}

function resample(input: Float32Array, start: number, end: number): Float32Array {
  const out = new Float32Array(SAMPLES_PER_WAVE);
  const span = Math.max(1, end - start);
  for (let i = 0; i < out.length; i++) {
    const position = start + (i / out.length) * span;
    const left = Math.min(input.length - 1, Math.max(0, Math.floor(position)));
    const right = Math.min(input.length - 1, left + 1);
    const fraction = position - left;
    out[i] = input[left] * (1 - fraction) + input[right] * fraction;
  }
  return conditionWave(out);
}

function normalizeCycle(input: Float32Array): Float32Array {
  const out = new Float32Array(input);
  let mean = 0;
  for (const value of out) mean += value;
  mean /= out.length || 1;
  let peak = 0;
  for (let i = 0; i < out.length; i++) {
    out[i] -= mean;
    peak = Math.max(peak, Math.abs(out[i]));
  }
  if (peak > 0) for (let i = 0; i < out.length; i++) out[i] = (out[i] / peak) * 0.98;
  return out;
}

export function singleCycleToWave(input: Float32Array): Float32Array {
  if (input.length < 8) throw new Error("The single-cycle file is too short.");
  const cycle = new Float32Array(SAMPLES_PER_WAVE);
  for (let i = 0; i < cycle.length; i++) {
    const position = (i / cycle.length) * input.length;
    const left = Math.floor(position) % input.length;
    const right = (left + 1) % input.length;
    const fraction = position - Math.floor(position);
    cycle[i] = input[left] * (1 - fraction) + input[right] * fraction;
  }
  return normalizeCycle(cycle);
}

export function singleCycleToBank(input: Float32Array): WaveBank {
  const normalized = singleCycleToWave(input);
  return Array.from({ length: WAVES_PER_BANK }, () => new Float32Array(normalized));
}

export function audioToBank(input: Float32Array): WaveBank {
  if (input.length < WAVES_PER_BANK) throw new Error("The audio file is too short.");
  const segment = input.length / WAVES_PER_BANK;
  return Array.from({ length: WAVES_PER_BANK }, (_, index) =>
    resample(input, Math.floor(index * segment), Math.floor((index + 1) * segment)),
  );
}

export function extractSequentialWaves(input: Float32Array, maximum = WAVES_PER_BANK): WaveBank {
  if (input.length < 8) throw new Error("The audio file is too short.");
  const count = Math.min(maximum, Math.ceil(input.length / SAMPLES_PER_WAVE));
  return Array.from({ length: count }, (_, index) => {
    const start = index * SAMPLES_PER_WAVE;
    const end = Math.min(input.length, start + SAMPLES_PER_WAVE);
    return resample(input, start, end);
  });
}

export function bankToRaw(bank: WaveBank): Uint8Array {
  if (bank.length !== WAVES_PER_BANK) throw new Error("A bank must contain exactly 8 waves.");
  const bytes = new Uint8Array(BANK_BYTES);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  for (const wave of bank) {
    if (wave.length !== SAMPLES_PER_WAVE) throw new Error("Each wave must contain exactly 512 samples.");
    for (const sample of wave) {
      const pcm = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
      view.setInt16(offset, pcm, true);
      offset += 2;
    }
  }
  return bytes;
}
