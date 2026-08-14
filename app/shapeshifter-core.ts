export const FIRMWARE_SIZE = 2 * 1024 * 1024;
export const BANK_COUNT = 128;
export const WAVES_PER_BANK = 8;
export const SAMPLES_PER_WAVE = 512;
export const BYTES_PER_SAMPLE = 2;
export const BANK_BYTES = WAVES_PER_BANK * SAMPLES_PER_WAVE * BYTES_PER_SAMPLE;
export const NAME_BASE = 0x0f0000;
export const WAVE_BASE = 0x100000;

export type WaveBank = Float32Array[];

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
  const harmonicCount = 32;
  const phases = Array.from({ length: harmonicCount }, (_, index) =>
    index === 0 ? random() * Math.PI * 2 : (random() - 0.5) * Math.PI,
  );
  const decayA = 0.8 + random() * 1.25;
  const decayB = 0.8 + random() * 1.25;
  const driveAmount = random() * 0.8;
  const profile = (harmonic: number, decay: number) => {
    const broadShape = 0.3 + random() * 0.9;
    const oddBias = harmonic % 2 === 1 ? 0.75 + random() * 0.5 : 0.2 + random() * 0.8;
    return (broadShape * oddBias) / Math.pow(harmonic, decay);
  };
  const spectrumA = Array.from({ length: harmonicCount }, (_, index) => profile(index + 1, decayA));
  const spectrumB = Array.from({ length: harmonicCount }, (_, index) => profile(index + 1, decayB));
  spectrumA[0] = Math.max(0.65, spectrumA[0]);
  spectrumB[0] = Math.max(0.65, spectrumB[0]);

  return Array.from({ length: WAVES_PER_BANK }, (_, waveIndex) => {
    const linear = waveIndex / (WAVES_PER_BANK - 1);
    const morph = linear * linear * (3 - 2 * linear);
    const drive = 1 + Math.sin(linear * Math.PI) * driveAmount;
    const wave = new Float32Array(SAMPLES_PER_WAVE);
    for (let sample = 0; sample < wave.length; sample++) {
      const phase = (sample / wave.length) * Math.PI * 2;
      let value = 0;
      for (let harmonic = 1; harmonic <= harmonicCount; harmonic++) {
        const amplitude = spectrumA[harmonic - 1] * (1 - morph) + spectrumB[harmonic - 1] * morph;
        value += amplitude * Math.sin(phase * harmonic + phases[harmonic - 1]);
      }
      wave[sample] = Math.tanh(value * drive);
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

export function patchFirmware(
  source: Uint8Array,
  bank: WaveBank,
  bankIndex: number,
  bankName: string,
): Uint8Array {
  if (source.byteLength !== FIRMWARE_SIZE) {
    throw new Error(`Firmware must be exactly ${FIRMWARE_SIZE.toLocaleString("en-US")} bytes.`);
  }
  if (!Number.isInteger(bankIndex) || bankIndex < 0 || bankIndex >= BANK_COUNT) {
    throw new Error("Invalid bank slot.");
  }
  const output = new Uint8Array(source);
  output.set(bankToRaw(bank), WAVE_BASE + bankIndex * BANK_BYTES);

  const safeName = bankName.toUpperCase().replace(/[^A-Z0-9 _-]/g, "").slice(0, 6).padEnd(6, " ");
  const displayName = `  ${safeName}`;
  for (let i = 0; i < 8; i++) output[NAME_BASE + bankIndex * 8 + i] = displayName.charCodeAt(i);
  return output;
}

export function readBankName(source: Uint8Array, bankIndex: number): string {
  if (source.byteLength !== FIRMWARE_SIZE) return "";
  const start = NAME_BASE + bankIndex * 8;
  return String.fromCharCode(...source.slice(start, start + 8)).trim();
}

export function changedByteCount(before: Uint8Array, after: Uint8Array): number {
  if (before.length !== after.length) return -1;
  let changed = 0;
  for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) changed++;
  return changed;
}
