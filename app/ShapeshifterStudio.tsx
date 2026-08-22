"use client";

/* eslint-disable @typescript-eslint/no-explicit-any -- WebUSB is not part of the standard TypeScript DOM declarations. */
/* eslint-disable no-empty -- USB cleanup is deliberately best-effort. */

import { ChangeEvent, DragEvent, useEffect, useRef, useState } from "react";
import {
  BANK_COUNT,
  WaveBank,
  audioToBank,
  bankToRaw,
  extractFirmwareImage,
  extractSequentialWaves,
  generateRandomBank,
  makeStarterBank,
  singleCycleToBank,
  singleCycleToWave,
} from "./shapeshifter-core";
import type { FirmwareImage } from "./shapeshifter-core";
import {
  createJicProgrammingTarget,
  createVerifiedFullFlashBackup,
  EPCS16_FLASH_SIZE,
  flashSizeForEpcsSiliconId,
  FirmwareStage,
  FirmwareUpdateError,
  PHYSICAL_FLASH_SIZE,
  restoreFullFlashBackup,
  runSafeFirmwareUpdate,
} from "./firmware-update";
import { UsbBlasterJtag, expectedShapeshifter, formatIdCode } from "./webusb-jtag";

// Complete-image JIC installation passed the physical 2.01 -> 2.04 hardware test.
// Keep this switch as an explicit emergency kill switch for public builds.
const FIRMWARE_WRITES_ENABLED = true;
const APP_VERSION = "0.3.1";
const DIAGNOSTIC_STORAGE_KEY = "waveport-diagnostic-log-v1";
const MAX_DIAGNOSTIC_ENTRIES = 500;

type DiagnosticEntry = {
  at: string;
  event: string;
  details?: string;
};

type UsbSummary = {
  product: string;
  serial: string;
  vendorId: number;
  productId: number;
  interfaces: number;
  endpoints: string;
};

type FlashBackup = {
  names: Uint8Array;
  waves: Uint8Array;
  waveSector: number;
  created: string;
};

type RestoreBackup = FlashBackup & {
  bankSlot: number;
  bankName: string;
  filename: string;
};

type ImportMode = "extract" | "spread";

type FullFirmwareFile = {
  bytes: Uint8Array;
  filename: string;
};

type OfficialFirmwareFile = FirmwareImage & { filename: string };

const USB_BLASTER_VENDOR = 0x09fb;
const USB_BLASTER_PRODUCT = 0x6001;

function download(bytes: Uint8Array, filename: string, type = "application/octet-stream") {
  const blob = new Blob([bytes.slice().buffer], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

async function sha256(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function packBackup(backup: FlashBackup, bankSlot: number) {
  const header = new Uint8Array(32);
  header.set(new TextEncoder().encode("WAVEPORT"), 0);
  const view = new DataView(header.buffer);
  view.setUint8(8, 1);
  view.setUint8(9, backup.waveSector);
  view.setUint16(10, bankSlot + 1, true);
  view.setUint32(12, backup.names.length, true);
  view.setUint32(16, backup.waves.length, true);
  const packed = new Uint8Array(header.length + backup.names.length + backup.waves.length);
  packed.set(header, 0);
  packed.set(backup.names, header.length);
  packed.set(backup.waves, header.length + backup.names.length);
  return packed;
}

function unpackBackup(bytes: Uint8Array, filename: string): RestoreBackup {
  const headerSize = 32;
  const sectorSize = 0x10000;
  if (bytes.length < headerSize) throw new Error("Rejected: the backup file is incomplete.");
  if (new TextDecoder().decode(bytes.subarray(0, 8)) !== "WAVEPORT") {
    throw new Error("Rejected: this is not a WavePort bank backup.");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(8);
  const waveSector = view.getUint8(9);
  const bankNumber = view.getUint16(10, true);
  const namesLength = view.getUint32(12, true);
  const wavesLength = view.getUint32(16, true);
  if (version !== 1) throw new Error(`Rejected: unsupported backup version ${version}.`);
  if (bankNumber < 1 || bankNumber > BANK_COUNT) throw new Error("Rejected: invalid bank number in backup.");
  const bankSlot = bankNumber - 1;
  const expectedSector = 16 + Math.floor(bankSlot / 8);
  if (waveSector !== expectedSector || waveSector < 16 || waveSector > 31) {
    throw new Error("Rejected: the bank and wave-sector information do not match.");
  }
  if (namesLength !== sectorSize || wavesLength !== sectorSize) {
    throw new Error("Rejected: backup sectors have the wrong size.");
  }
  if (bytes.length !== headerSize + namesLength + wavesLength) {
    throw new Error("Rejected: the backup file size does not match its header.");
  }
  const names = bytes.slice(headerSize, headerSize + namesLength);
  const waves = bytes.slice(headerSize + namesLength);
  const nameOffset = bankSlot * 8;
  const bankName = String.fromCharCode(...names.subarray(nameOffset, nameOffset + 8)).trim() || "unnamed";
  return {
    names,
    waves,
    waveSector,
    bankSlot,
    bankName,
    filename,
    created: new Date().toISOString().replace(/[:.]/g, "-"),
  };
}

function WaveCanvas({ wave, active, onClick }: { wave: Float32Array; active: boolean; onClick: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    canvas.width = width * ratio;
    canvas.height = height * ratio;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    ctx.clearRect(0, 0, width, height);
    ctx.strokeStyle = active ? "#ffd84a" : "#718096";
    ctx.lineWidth = active ? 2 : 1.25;
    ctx.beginPath();
    for (let i = 0; i < wave.length; i++) {
      const x = (i / (wave.length - 1)) * width;
      const y = height / 2 - wave[i] * (height * 0.39);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }, [wave, active]);
  return <canvas ref={ref} className="wave-canvas" onClick={onClick} aria-label="Select wave" />;
}

export default function ShapeshifterStudio() {
  const [bank, setBank] = useState<WaveBank>(() => makeStarterBank());
  const [selectedWave, setSelectedWave] = useState(0);
  const [bankSlot, setBankSlot] = useState(120);
  const [bankName, setBankName] = useState("MYWAVE");
  const [audioName, setAudioName] = useState("Starter Waves");
  const [status, setStatus] = useState("Ready. Files never leave your browser.");
  const [usb, setUsb] = useState<UsbSummary | null>(null);
  const [usbError, setUsbError] = useState("");
  const [jtagId, setJtagId] = useState("");
  const [jtagBusy, setJtagBusy] = useState(false);
  const [backup, setBackup] = useState<FlashBackup | null>(null);
  const [backupProgress, setBackupProgress] = useState(0);
  const [writeProgress, setWriteProgress] = useState(0);
  const [writeReviewOpen, setWriteReviewOpen] = useState(false);
  const [writeConfirmation, setWriteConfirmation] = useState("");
  const [waveDropTarget, setWaveDropTarget] = useState<number | null>(null);
  const [importMode, setImportMode] = useState<ImportMode>("extract");
  const [restoreBackup, setRestoreBackup] = useState<RestoreBackup | null>(null);
  const [restoreConfirmation, setRestoreConfirmation] = useState("");
  const [restoreProgress, setRestoreProgress] = useState(0);
  const [officialFirmware, setOfficialFirmware] = useState<OfficialFirmwareFile | null>(null);
  const [fullRecoveryBackup, setFullRecoveryBackup] = useState<FullFirmwareFile | null>(null);
  const [firmwareConfirmation, setFirmwareConfirmation] = useState("");
  const [fullRecoveryConfirmation, setFullRecoveryConfirmation] = useState("");
  const [firmwareProgress, setFirmwareProgress] = useState(0);
  const [fullFlashBackupName, setFullFlashBackupName] = useState("");
  const [firmwareDryRunResult, setFirmwareDryRunResult] = useState("");
  const [webUsbAvailable, setWebUsbAvailable] = useState(false);
  const [diagnosticEntries, setDiagnosticEntries] = useState<DiagnosticEntry[]>([]);
  const audioInput = useRef<HTMLInputElement>(null);
  const restoreInput = useRef<HTMLInputElement>(null);
  const officialFirmwareInput = useRef<HTMLInputElement>(null);
  const fullRecoveryInput = useRef<HTMLInputElement>(null);
  const lastFirmwareStage = useRef<FirmwareStage | null>(null);
  const firmwareProgressValue = useRef(0);

  function storeDiagnosticEntries(entries: DiagnosticEntry[]) {
    try { window.localStorage.setItem(DIAGNOSTIC_STORAGE_KEY, JSON.stringify(entries)); } catch {}
  }

  function appendDiagnostic(event: string, details?: string) {
    const entry: DiagnosticEntry = { at: new Date().toISOString(), event, ...(details ? { details } : {}) };
    setDiagnosticEntries((current) => {
      const next = [...current, entry].slice(-MAX_DIAGNOSTIC_ENTRIES);
      storeDiagnosticEntries(next);
      return next;
    });
  }

  function updateFirmwareProgress(value: number) {
    firmwareProgressValue.current = value;
    setFirmwareProgress(value);
  }

  function downloadDiagnosticLog() {
    const lines = [
      "WavePort diagnostic log",
      `Generated: ${new Date().toISOString()}`,
      `Application: WavePort ${APP_VERSION}`,
      "Privacy: stored locally; no flash contents, audio, USB serial number, or file contents are included.",
      "",
      ...diagnosticEntries.map((entry) => `${entry.at}  ${entry.event}${entry.details ? `  ${entry.details}` : ""}`),
      "",
    ];
    const created = new Date().toISOString().replace(/[:.]/g, "-");
    download(new TextEncoder().encode(lines.join("\n")), `waveport-diagnostic-${created}.txt`, "text/plain");
  }

  function clearDiagnosticLog() {
    setDiagnosticEntries([]);
    try { window.localStorage.removeItem(DIAGNOSTIC_STORAGE_KEY); } catch {}
  }

  useEffect(() => {
    let previous: DiagnosticEntry[] = [];
    try {
      const parsed = JSON.parse(window.localStorage.getItem(DIAGNOSTIC_STORAGE_KEY) ?? "[]");
      if (Array.isArray(parsed)) {
        previous = parsed.filter((entry): entry is DiagnosticEntry =>
          Boolean(entry && typeof entry.at === "string" && typeof entry.event === "string"));
      }
    } catch {}
    const started: DiagnosticEntry = {
      at: new Date().toISOString(),
      event: "session.start",
      details: `WavePort ${APP_VERSION}; ${navigator.userAgent}`,
    };
    const next = [...previous, started].slice(-MAX_DIAGNOSTIC_ENTRIES);
    void Promise.resolve().then(() => setDiagnosticEntries(next));
    storeDiagnosticEntries(next);
  }, []);

  useEffect(() => {
    const available = "usb" in navigator;
    if (!available) return;
    void Promise.resolve().then(() => setWebUsbAvailable(true));
    const usbApi = (navigator as Navigator & { usb: any }).usb;
    void usbApi.getDevices().then((devices: any[]) => {
      const device = devices.find(
        (candidate) => candidate.vendorId === USB_BLASTER_VENDOR && candidate.productId === USB_BLASTER_PRODUCT,
      );
      if (!device) return;
      const configuration = device.configuration ?? device.configurations?.[0];
      const interfaces = configuration?.interfaces ?? [];
      const endpoints = interfaces
        .flatMap((item: any) => item.alternate?.endpoints ?? [])
        .map((endpoint: any) => `${endpoint.direction} EP${endpoint.endpointNumber} ${endpoint.type}`)
        .join(", ");
      setUsb({
        product: device.productName || "Altera USB-Blaster",
        serial: device.serialNumber || "not reported",
        vendorId: device.vendorId,
        productId: device.productId,
        interfaces: interfaces.length,
        endpoints: endpoints || "no endpoints reported",
      });
    });
  }, []);

  async function loadAudioFile(file: File) {
    try {
      const context = new AudioContext();
      const buffer = await context.decodeAudioData(await file.arrayBuffer());
      const mono = new Float32Array(buffer.length);
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        const data = buffer.getChannelData(channel);
        for (let i = 0; i < data.length; i++) mono[i] += data[i] / buffer.numberOfChannels;
      }
      const singleCycle = mono.length <= 2048;
      if (singleCycle) {
        setBank(singleCycleToBank(mono));
      } else if (importMode === "extract") {
        const extracted = extractSequentialWaves(mono);
        setBank((current) => current.map((wave, index) => extracted[index] ?? wave));
      } else {
        setBank(audioToBank(mono));
      }
      setAudioName(file.name);
      setStatus(singleCycle
        ? `${file.name}: single cycle with ${mono.length} samples detected, periodically resampled to 512 samples and placed in all 8 waves.`
        : importMode === "extract"
          ? `${file.name}: extracted ${Math.min(8, Math.ceil(mono.length / 512))} consecutive waves starting at sample 1; used at most 4,096 samples.`
          : `${file.name}: distributed the entire file across 8 waves of 512 samples each.`);
      await context.close();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "The audio file could not be read.");
    }
  }

  function makeRandomBank() {
    setBank(generateRandomBank());
    setSelectedWave(0);
    setAudioName("Random Wavetable Set");
    setBackup(null);
    setWriteReviewOpen(false);
    setStatus("Generated a random wavetable set: 8 evolving waves with moving formants, phase warping, drive, and wave folding.");
  }

  async function loadAudioFiles(files: File[]) {
    if (!files.length) return;
    if (files.length === 1) return loadAudioFile(files[0]);
    const ordered = [...files]
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
      .slice(0, 8);
    try {
      const waves: Float32Array[] = [];
      for (const file of ordered) waves.push(singleCycleToWave(await decodeMono(file)));
      setBank((current) => current.map((wave, index) => waves[index] ?? wave));
      setSelectedWave(0);
      setAudioName(`${waves.length} Single Cycles · ${ordered[0].name} …`);
      setBackup(null);
      setWriteReviewOpen(false);
      setStatus(`${waves.length} single-cycle files sorted numerically and placed on W1–W${waves.length}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "The single-cycle files could not be read.");
    }
  }

  async function decodeMono(file: File) {
    const context = new AudioContext();
    try {
      const buffer = await context.decodeAudioData(await file.arrayBuffer());
      const mono = new Float32Array(buffer.length);
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        const data = buffer.getChannelData(channel);
        for (let i = 0; i < data.length; i++) mono[i] += data[i] / buffer.numberOfChannels;
      }
      return mono;
    } finally {
      await context.close();
    }
  }

  async function loadWaveFiles(files: File[], index: number) {
    try {
      const ordered = [...files]
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
        .slice(0, 8 - index);
      const replacements: Float32Array[] = [];
      for (const file of ordered) replacements.push(singleCycleToWave(await decodeMono(file)));
      setBank((current) => current.map((wave, waveIndex) => replacements[waveIndex - index] ?? wave));
      setSelectedWave(index);
      setAudioName(`Custom Bank · ${ordered.length} Cycle${ordered.length === 1 ? "" : "s"} from W${index + 1}`);
      setBackup(null);
      setWriteReviewOpen(false);
      setStatus(`${ordered.length} single cycle${ordered.length === 1 ? "" : "s"} placed on W${index + 1}–W${index + replacements.length} and resampled to 512 samples each.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "The single-cycle file could not be read.");
    } finally {
      setWaveDropTarget(null);
    }
  }

  async function connectUsb() {
    setUsbError("");
    if (!webUsbAvailable) {
      setUsbError("WebUSB is unavailable. Use Chrome or Edge on a desktop computer.");
      return;
    }
    try {
      const usbApi = (navigator as Navigator & { usb: any }).usb;
      const device = await usbApi.requestDevice({ filters: [{ vendorId: USB_BLASTER_VENDOR }] });
      await device.open();
      if (!device.configuration && device.configurations?.length) {
        await device.selectConfiguration(device.configurations[0].configurationValue);
      }
      const interfaces = device.configuration?.interfaces ?? [];
      const endpoints = interfaces
        .flatMap((item: any) => item.alternate?.endpoints ?? [])
        .map((endpoint: any) => `${endpoint.direction} EP${endpoint.endpointNumber} ${endpoint.type}`)
        .join(", ");
      setUsb({
        product: device.productName || "Altera USB-Blaster",
        serial: device.serialNumber || "not reported",
        vendorId: device.vendorId,
        productId: device.productId,
        interfaces: interfaces.length,
        endpoints: endpoints || "no endpoints reported",
      });
      setJtagId("");
      await device.close();
      setStatus("Shapeshifter connection found. Nothing was read or changed.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "USB access failed.";
      setUsbError(message.includes("No device selected") ? "Device selection was canceled." : message);
    }
  }

  async function openJtagSession() {
    const usbApi = (navigator as Navigator & { usb: any }).usb;
    const permitted = await usbApi.getDevices();
    const device = permitted.find(
      (candidate: any) => candidate.vendorId === USB_BLASTER_VENDOR && candidate.productId === USB_BLASTER_PRODUCT,
    );
    if (!device) throw new Error("Connection permission is missing. Reconnect the Shapeshifter.");
    await device.open();
    if (!device.configuration) await device.selectConfiguration(1);
    const usbInterface = device.configuration.interfaces[0];
    const interfaceNumber = usbInterface.interfaceNumber;
    await device.claimInterface(interfaceNumber);
    const endpoints = usbInterface.alternate.endpoints;
    const inEndpoint = endpoints.find((endpoint: any) => endpoint.direction === "in")?.endpointNumber;
    const outEndpoint = endpoints.find((endpoint: any) => endpoint.direction === "out")?.endpointNumber;
    if (inEndpoint == null || outEndpoint == null) throw new Error("The Shapeshifter connection could not be opened.");
    const jtag = new UsbBlasterJtag(device, inEndpoint, outEndpoint, appendDiagnostic);
    await jtag.initialize();
    appendDiagnostic("usb.session.open", `interface=${interfaceNumber} inEndpoint=${inEndpoint} outEndpoint=${outEndpoint}`);
    return { device, interfaceNumber, jtag };
  }

  async function scanJtagId() {
    setUsbError("");
    setJtagBusy(true);
    let device: any = null;
    let interfaceNumber = 0;
    try {
      const session = await openJtagSession();
      ({ device, interfaceNumber } = session);
      await session.jtag.readIdCode();
      const value = await session.jtag.readIdCode();
      const formatted = formatIdCode(value);
      if (!expectedShapeshifter(value)) {
        throw new Error("The connected device is not a supported Shapeshifter.");
      }
      setJtagId(formatted);
      setStatus("Shapeshifter verified. Nothing was changed.");
      appendDiagnostic("jtag.fpga.verified", `id=${formatted}`);
    } catch (error) {
      const message = errorMessage(error, "The Shapeshifter connection could not be verified.");
      appendDiagnostic("jtag.fpga.error", message);
      setUsbError(message);
    } finally {
      try { if (device?.opened) await device.releaseInterface(interfaceNumber); } catch {}
      try { if (device?.opened) await device.close(); } catch {}
      setJtagBusy(false);
    }
  }

  async function createFlashBackup() {
    if (!window.confirm(
      "Create a safety backup? WavePort will read the current bank data without changing it, then restart the Shapeshifter automatically.",
    )) return;

    setUsbError("");
    setJtagBusy(true);
    setBackup(null);
    setBackupProgress(0);
    let device: any = null;
    let interfaceNumber = 0;
    let jtag: UsbBlasterJtag | null = null;
    let bridgeLoaded = false;
    try {
      const session = await openJtagSession();
      ({ device, interfaceNumber, jtag } = session);
      await jtag.readIdCode();
      const id = await jtag.readIdCode();
      if (!expectedShapeshifter(id)) throw new Error("The connected device is not a supported Shapeshifter.");

      setStatus("Preparing the Shapeshifter for backup …");
      const response = await fetch(new URL("bridges/spiOverJtag_ep4ce2217.rbf", document.baseURI));
      if (!response.ok) throw new Error("The backup service could not be prepared.");
      const bridge = new Uint8Array(await response.arrayBuffer());
      await jtag.loadSpiBridge(bridge, (fraction) => setBackupProgress(fraction * 55));
      bridgeLoaded = true;

      setStatus("Saving bank names …");
      const names = await jtag.readFlash(0x0f0000, 0x10000, (fraction) => setBackupProgress(55 + fraction * 20));
      const waveSector = 16 + Math.floor(bankSlot / 8);
      const firstSlot = Math.floor(bankSlot / 8) * 8 + 1;
      setStatus(`Saving banks ${firstSlot}–${firstSlot + 7} …`);
      const waves = await jtag.readFlash(waveSector * 0x10000, 0x10000, (fraction) => setBackupProgress(75 + fraction * 20));

      setStatus("Restarting the Shapeshifter …");
      await jtag.restartFromFlash();
      bridgeLoaded = false;
      setBackup({ names, waves, waveSector, created: new Date().toISOString().replace(/[:.]/g, "-") });
      setBackupProgress(100);
      setStatus(`Safety backup for bank ${bankSlot + 1} completed. Download and keep the backup file.`);
    } catch (error) {
      setUsbError(error instanceof Error ? error.message : "Safety backup failed.");
    } finally {
      if (bridgeLoaded && jtag) {
        try { await jtag.restartFromFlash(); } catch {}
      }
      try { if (device?.opened) await device.releaseInterface(interfaceNumber); } catch {}
      try { if (device?.opened) await device.close(); } catch {}
      setJtagBusy(false);
    }
  }

  async function loadRestoreBackup(file: File) {
    setUsbError("");
    try {
      const parsed = unpackBackup(new Uint8Array(await file.arrayBuffer()), file.name);
      setRestoreBackup(parsed);
      setRestoreConfirmation("");
      setRestoreProgress(0);
      setBankSlot(parsed.bankSlot);
      setBackup(null);
      setWriteReviewOpen(false);
      setStatus(`Backup validated: bank ${parsed.bankSlot + 1} “${parsed.bankName}”. Review the restore details before writing.`);
    } catch (error) {
      setRestoreBackup(null);
      setRestoreConfirmation("");
      setUsbError(error instanceof Error ? error.message : "The backup file could not be read.");
    }
  }

  async function restoreBankBackup() {
    if (!restoreBackup) return;
    const restoreSlot = restoreBackup.bankSlot;
    const waveAddress = restoreBackup.waveSector * 0x10000;
    const waveOffset = (restoreSlot % 8) * 0x2000;
    const nameOffset = restoreSlot * 8;
    setUsbError("");
    setJtagBusy(true);
    setRestoreProgress(0);
    let device: any = null;
    let interfaceNumber = 0;
    let jtag: UsbBlasterJtag | null = null;
    let bridgeLoaded = false;
    let currentNames: Uint8Array | null = null;
    let currentWaves: Uint8Array | null = null;
    let wavesTouched = false;
    let namesTouched = false;
    try {
      const session = await openJtagSession();
      ({ device, interfaceNumber, jtag } = session);
      await jtag.readIdCode();
      const id = await jtag.readIdCode();
      if (!expectedShapeshifter(id)) throw new Error("Restore canceled: the connected device is not a supported Shapeshifter.");

      setStatus("Preparing the Shapeshifter for bank restore …");
      const response = await fetch(new URL("bridges/spiOverJtag_ep4ce2217.rbf", document.baseURI));
      if (!response.ok) throw new Error("The restore service could not be prepared.");
      await jtag.loadSpiBridge(new Uint8Array(await response.arrayBuffer()), (fraction) => setRestoreProgress(fraction * 15));
      bridgeLoaded = true;
      const siliconId = await jtag.readEpcsSiliconId();
      if (siliconId !== 0x14 && siliconId !== 0x16) throw new Error(`Restore canceled: unexpected flash ID 0x${siliconId.toString(16).padStart(2, "0")}.`);

      setStatus("Reading the current bank data before restore …");
      currentNames = await jtag.readFlash(0x0f0000, 0x10000, (fraction) => setRestoreProgress(15 + fraction * 7));
      currentWaves = await jtag.readFlash(waveAddress, 0x10000, (fraction) => setRestoreProgress(22 + fraction * 8));
      const targetNames = new Uint8Array(currentNames);
      const targetWaves = new Uint8Array(currentWaves);
      targetNames.set(restoreBackup.names.subarray(nameOffset, nameOffset + 8), nameOffset);
      targetWaves.set(restoreBackup.waves.subarray(waveOffset, waveOffset + 0x2000), waveOffset);

      if (!equalBytes(currentWaves, targetWaves)) {
        setStatus(`Restoring and checking bank ${restoreSlot + 1} …`);
        wavesTouched = true;
        await jtag.writeFlashSector(waveAddress, targetWaves, (fraction) => setRestoreProgress(30 + fraction * 32));
        if (!equalBytes(await jtag.readFlash(waveAddress, 0x10000, (fraction) => setRestoreProgress(62 + fraction * 12)), targetWaves)) {
          throw new Error(`Bank ${restoreSlot + 1} did not verify correctly after restoring.`);
        }
      }

      if (!equalBytes(currentNames, targetNames)) {
        setStatus("Restoring and checking the bank name …");
        namesTouched = true;
        await jtag.writeFlashSector(0x0f0000, targetNames, (fraction) => setRestoreProgress(74 + fraction * 16));
        if (!equalBytes(await jtag.readFlash(0x0f0000, 0x10000, (fraction) => setRestoreProgress(90 + fraction * 8)), targetNames)) {
          throw new Error("The restored bank name did not verify correctly.");
        }
      }

      await jtag.restartFromFlash();
      bridgeLoaded = false;
      setRestoreProgress(100);
      setBackup({ names: targetNames, waves: targetWaves, waveSector: restoreBackup.waveSector, created: new Date().toISOString().replace(/[:.]/g, "-") });
      setRestoreBackup(null);
      setRestoreConfirmation("");
      setStatus(`Success: bank ${restoreSlot + 1} “${restoreBackup.bankName}” was restored and verified. Other banks were left unchanged.`);
    } catch (error) {
      let message = error instanceof Error ? error.message : "Bank restore failed.";
      if (bridgeLoaded && jtag && currentNames && currentWaves && (wavesTouched || namesTouched)) {
        try {
          setStatus("Restore error — returning affected sectors to their previous state …");
          if (wavesTouched) {
            await jtag.writeFlashSector(waveAddress, currentWaves);
            if (!equalBytes(await jtag.readFlash(waveAddress, 0x10000), currentWaves)) throw new Error("The previous wave sector could not be verified.");
          }
          if (namesTouched) {
            await jtag.writeFlashSector(0x0f0000, currentNames);
            if (!equalBytes(await jtag.readFlash(0x0f0000, 0x10000), currentNames)) throw new Error("The previous name sector could not be verified.");
          }
          message += " The affected sectors were returned to their previous state and verified.";
        } catch (rollbackError) {
          message += ` WARNING: rollback failed: ${rollbackError instanceof Error ? rollbackError.message : "unknown error"}`;
        }
      }
      setUsbError(message);
    } finally {
      if (bridgeLoaded && jtag) {
        try { await jtag.restartFromFlash(); } catch {}
      }
      try { if (device?.opened) await device.releaseInterface(interfaceNumber); } catch {}
      try { if (device?.opened) await device.close(); } catch {}
      setJtagBusy(false);
    }
  }

  function equalBytes(a: Uint8Array, b: Uint8Array) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function makeSectorTargets(source: FlashBackup) {
    const names = new Uint8Array(source.names);
    const safeName = bankName.toUpperCase().replace(/[^A-Z0-9 _-]/g, "").slice(0, 6).padEnd(6, " ");
    const encodedName = `  ${safeName}`;
    for (let i = 0; i < 8; i++) names[bankSlot * 8 + i] = encodedName.charCodeAt(i);

    const waves = new Uint8Array(source.waves);
    waves.set(bankToRaw(bank), (bankSlot % 8) * 0x2000);
    return { names, waves };
  }

  async function writeBankToFlash() {
    if (!backup) return;
    const requiredSector = 16 + Math.floor(bankSlot / 8);
    if (backup.waveSector !== requiredSector) {
      setUsbError(`Create a new safety backup for bank ${bankSlot + 1} before writing.`);
      return;
    }
    setUsbError("");
    setJtagBusy(true);
    setWriteReviewOpen(false);
    setWriteProgress(0);
    let device: any = null;
    let interfaceNumber = 0;
    let jtag: UsbBlasterJtag | null = null;
    let bridgeLoaded = false;
    let waveWriteStarted = false;
    let namesWriteStarted = false;
    try {
      const targets = makeSectorTargets(backup);
      const session = await openJtagSession();
      ({ device, interfaceNumber, jtag } = session);
      await jtag.readIdCode();
      const id = await jtag.readIdCode();
      if (!expectedShapeshifter(id)) throw new Error("The connected device is not a supported Shapeshifter.");

      setStatus("Preparing the Shapeshifter for writing …");
      const response = await fetch(new URL("bridges/spiOverJtag_ep4ce2217.rbf", document.baseURI));
      if (!response.ok) throw new Error("The writing service could not be prepared.");
      await jtag.loadSpiBridge(new Uint8Array(await response.arrayBuffer()), (fraction) => setWriteProgress(fraction * 15));
      bridgeLoaded = true;

      setStatus("Checking current data against the safety backup …");
      const currentNames = await jtag.readFlash(0x0f0000, 0x10000, (fraction) => setWriteProgress(15 + fraction * 5));
      const waveAddress = requiredSector * 0x10000;
      const currentWaves = await jtag.readFlash(waveAddress, 0x10000, (fraction) => setWriteProgress(20 + fraction * 5));
      if (!equalBytes(currentNames, backup.names) || !equalBytes(currentWaves, backup.waves)) {
        throw new Error("Writing canceled because the Shapeshifter data changed after the backup. Create a new safety backup.");
      }

      setStatus(`Writing and checking bank ${bankSlot + 1} …`);
      waveWriteStarted = true;
      await jtag.writeFlashSector(waveAddress, targets.waves, (fraction) => setWriteProgress(25 + fraction * 35));
      const verifiedWaves = await jtag.readFlash(waveAddress, 0x10000, (fraction) => setWriteProgress(60 + fraction * 12));
      if (!equalBytes(verifiedWaves, targets.waves)) {
        throw new Error(`Sector ${requiredSector} did not verify correctly after writing.`);
      }
      waveWriteStarted = false;

      if (!equalBytes(targets.names, backup.names)) {
        setStatus("Writing and checking the display name …");
        namesWriteStarted = true;
        await jtag.writeFlashSector(0x0f0000, targets.names, (fraction) => setWriteProgress(72 + fraction * 18));
        const verifiedNames = await jtag.readFlash(0x0f0000, 0x10000, (fraction) => setWriteProgress(90 + fraction * 8));
        if (!equalBytes(verifiedNames, targets.names)) {
          throw new Error("The name sector did not verify correctly after writing.");
        }
        namesWriteStarted = false;
      }

      await jtag.restartFromFlash();
      bridgeLoaded = false;
      setBackup({ ...backup, names: targets.names, waves: targets.waves, created: new Date().toISOString().replace(/[:.]/g, "-") });
      setWriteProgress(100);
      setStatus(`Success: bank ${bankSlot + 1} was written and fully verified, and the Shapeshifter restarted.`);
    } catch (error) {
      let message = error instanceof Error ? error.message : "Flash write failed.";
      if (bridgeLoaded && jtag && (waveWriteStarted || namesWriteStarted)) {
        try {
          setStatus("Write error — automatically restoring affected sectors from the backup …");
          if (waveWriteStarted) {
            const address = requiredSector * 0x10000;
            await jtag.writeFlashSector(address, backup.waves);
            if (!equalBytes(await jtag.readFlash(address, 0x10000), backup.waves)) throw new Error(`Recovery of sector ${requiredSector} was not verified.`);
          }
          if (namesWriteStarted) {
            await jtag.writeFlashSector(0x0f0000, backup.names);
            if (!equalBytes(await jtag.readFlash(0x0f0000, 0x10000), backup.names)) throw new Error("Recovery of sector 15 was not verified.");
          }
          message += " Affected sectors were restored from the backup and verified.";
        } catch (recoveryError) {
          message += ` WARNING: Automatic recovery failed: ${recoveryError instanceof Error ? recoveryError.message : "unknown error"}`;
        }
      }
      setUsbError(message);
    } finally {
      if (bridgeLoaded && jtag) {
        try { await jtag.restartFromFlash(); } catch {}
      }
      try { if (device?.opened) await device.releaseInterface(interfaceNumber); } catch {}
      try { if (device?.opened) await device.close(); } catch {}
      setJtagBusy(false);
    }
  }

  async function loadOfficialFirmware(file: File) {
    setUsbError("");
    try {
      const parsed = extractFirmwareImage(new Uint8Array(await file.arrayBuffer()));
      if (parsed.format !== "JIC") {
        throw new Error("Firmware updates require an official Shapeshifter .jic file, not a raw image.");
      }
      setOfficialFirmware({ ...parsed, filename: file.name });
      setFirmwareConfirmation("");
      updateFirmwareProgress(0);
      setStatus(`Official Shapeshifter firmware verified: ${file.name}.`);
      const digest = await sha256(parsed.bytes);
      appendDiagnostic(
        "firmware.jic.validated",
        `file=${file.name} fileBytes=${file.size} imageBytes=${parsed.bytes.length} imageSha256=${digest}`,
      );
    } catch (error) {
      setOfficialFirmware(null);
      setFirmwareConfirmation("");
      const message = errorMessage(error, "The firmware file could not be validated.");
      appendDiagnostic("firmware.jic.rejected", `file=${file.name} fileBytes=${file.size} error=${message}`);
      setUsbError(message);
    }
  }

  async function loadFullRecoveryBackup(file: File) {
    setUsbError("");
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.length !== EPCS16_FLASH_SIZE && bytes.length !== PHYSICAL_FLASH_SIZE) {
        throw new Error("Choose the complete 2 MB or 8 MB backup created before the update.");
      }
      setFullRecoveryBackup({ bytes, filename: file.name });
      setFullRecoveryConfirmation("");
      updateFirmwareProgress(0);
      setStatus(`Safety copy loaded: ${file.name}. Recovery will be checked only against this same file.`);
      appendDiagnostic("recovery.file.loaded", `file=${file.name} bytes=${bytes.length}`);
    } catch (error) {
      setFullRecoveryBackup(null);
      setFullRecoveryConfirmation("");
      const message = errorMessage(error, "The full-flash backup could not be loaded.");
      appendDiagnostic("recovery.file.rejected", `file=${file.name} fileBytes=${file.size} error=${message}`);
      setUsbError(message);
    }
  }

  async function loadFullFlashBridge(jtag: UsbBlasterJtag, progress: (fraction: number) => void) {
    await jtag.readIdCode();
    const id = await jtag.readIdCode();
    if (!expectedShapeshifter(id)) throw new Error(`Canceled: wrong FPGA ${formatIdCode(id)}.`);
    const response = await fetch(new URL("bridges/spiOverJtag_ep4ce2217.rbf", document.baseURI));
    if (!response.ok) throw new Error("The full-flash service could not be prepared.");
    const bridge = new Uint8Array(await response.arrayBuffer());
    appendDiagnostic("bridge.load.start", `fpgaId=${formatIdCode(id)} bytes=${bridge.length}`);
    await jtag.loadSpiBridge(bridge, progress);
    appendDiagnostic("bridge.load.complete", `fpgaId=${formatIdCode(id)}`);
    const siliconId = await jtag.readEpcsSiliconId();
    try {
      const flashSize = flashSizeForEpcsSiliconId(siliconId);
      appendDiagnostic(
        "flash.detected",
        `siliconId=0x${siliconId.toString(16).padStart(2, "0")} bytes=${flashSize} type=${flashSize === EPCS16_FLASH_SIZE ? "EPCS16" : "EPCS64"}`,
      );
      return flashSize;
    } catch (error) {
      appendDiagnostic("flash.unsupported", `siliconId=0x${siliconId.toString(16).padStart(2, "0")}`);
      throw new Error(`Canceled: ${error instanceof Error ? error.message : "unsupported flash chip"}`);
    }
  }

  function reportFirmwareProgress(stage: FirmwareStage, fraction: number) {
    const ranges: Record<FirmwareStage, [number, number, string]> = {
      "backup-read": [10, 23, "Creating the safety copy (first read) …"],
      "backup-confirm": [23, 36, "Checking the safety copy with a second read …"],
      "backup-save": [36, 40, "Saving the verified safety copy …"],
      "update-write": [40, 75, "Replacing the complete 2 MB firmware area …"],
      "update-verify": [75, 98, "Checking the complete flash before restart …"],
      "rollback-write": [40, 78, "Update error — restoring the original firmware …"],
      "rollback-verify": [78, 98, "Checking the restored safety copy …"],
      "recovery-write": [10, 72, "Restoring the original firmware from the safety copy …"],
      "recovery-verify": [72, 98, "Checking the complete restored flash …"],
      restart: [98, 100, "Verified byte-for-byte. Restarting the Shapeshifter from flash …"],
    };
    const [start, end, message] = ranges[stage];
    if (lastFirmwareStage.current !== stage) {
      lastFirmwareStage.current = stage;
      appendDiagnostic("firmware.stage", `${stage} overallRange=${start}-${end}%`);
    }
    updateFirmwareProgress(start + (end - start) * fraction);
    setStatus(message);
  }

  async function chooseFullBackupDestination() {
    const created = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `shapeshifter-full-flash-before-firmware-${created}.bin`;
    const picker = (window as any).showSaveFilePicker as undefined | ((options: any) => Promise<any>);
    if (picker) {
      try {
        const handle = await picker({
          suggestedName: filename,
          types: [{ description: "Complete Shapeshifter safety copy", accept: { "application/octet-stream": [".bin"] } }],
        });
        return async (bytes: Uint8Array) => {
          const writable = await handle.createWritable();
          await writable.write(bytes);
          await writable.close();
        };
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return null;
        throw error;
      }
    }
    return async (bytes: Uint8Array) => {
      download(bytes, filename);
      if (!window.confirm(
        `The safety-copy download “${filename}” was started. Confirm only after the file is safely stored. No firmware will be written otherwise.`,
      )) throw new Error("Firmware update canceled because permanent backup storage was not confirmed.");
    };
  }

  async function testOfficialFirmware() {
    if (!FIRMWARE_WRITES_ENABLED) {
      setUsbError("Firmware writing is temporarily disabled after hardware validation. Read-only backup and full recovery remain available.");
      return;
    }
    if (!officialFirmware) return;
    appendDiagnostic("firmware.update.requested", `file=${officialFirmware.filename}`);
    let persistBackup: ((bytes: Uint8Array) => Promise<void>) | null;
    try {
      persistBackup = await chooseFullBackupDestination();
    } catch (error) {
      const message = errorMessage(error, "The permanent backup destination could not be opened.");
      appendDiagnostic("firmware.backup.destination.error", message);
      setUsbError(message);
      return;
    }
    if (!persistBackup) {
      setStatus("Firmware update canceled before accessing the Shapeshifter. Nothing was changed.");
      appendDiagnostic("firmware.update.canceled", "backup destination was canceled; flash untouched");
      return;
    }

    setUsbError("");
    setJtagBusy(true);
    setFirmwareConfirmation("");
    updateFirmwareProgress(0);
    lastFirmwareStage.current = null;
    let device: any = null;
    let interfaceNumber = 0;
    let jtag: UsbBlasterJtag | null = null;
    let bridgeLoaded = false;
    let flashWriteAttempted = false;
    try {
      const session = await openJtagSession();
      ({ device, interfaceNumber, jtag } = session);
      setStatus("Preparing the Shapeshifter for the safe firmware update …");
      const flashSize = await loadFullFlashBridge(jtag, (fraction) => updateFirmwareProgress(fraction * 10));
      bridgeLoaded = true;
      const progress = (stage: FirmwareStage, fraction: number) => {
        if (stage === "update-write") flashWriteAttempted = true;
        reportFirmwareProgress(stage, fraction);
      };
      const saveBackup = async (bytes: Uint8Array) => {
        await persistBackup(bytes);
        appendDiagnostic("firmware.backup.saved", `bytes=${bytes.length}`);
      };
      const result = await runSafeFirmwareUpdate(jtag, officialFirmware, saveBackup, progress, flashSize);
      bridgeLoaded = false;
      updateFirmwareProgress(100);
      setJtagId("");
      setStatus(result.changed
        ? "Complete 2 MB firmware image verified byte-for-byte. The Shapeshifter restarted."
        : "The selected firmware was already installed. Nothing was written; the Shapeshifter restarted.");
      appendDiagnostic(
        "firmware.update.success",
        result.changed ? "complete image verified; restart complete" : "image already installed; restart complete",
      );
    } catch (error) {
      if (error instanceof FirmwareUpdateError && error.restarted) bridgeLoaded = false;
      if (bridgeLoaded && jtag && !flashWriteAttempted) {
        try {
          await jtag.restartFromFlash();
          bridgeLoaded = false;
          appendDiagnostic("bridge.restart.after-prewrite-error", "complete");
        } catch (restartError) {
          appendDiagnostic("bridge.restart.after-prewrite-error.failed", errorMessage(restartError, "unknown restart error"));
        }
      }
      const message = errorMessage(error, "Safe firmware update failed.");
      appendDiagnostic(
        "firmware.update.error",
        `stage=${lastFirmwareStage.current ?? "bridge"} overallPercent=${firmwareProgressValue.current.toFixed(1)} writeAttempted=${flashWriteAttempted} rollbackVerified=${error instanceof FirmwareUpdateError ? error.rollbackVerified : false} restarted=${error instanceof FirmwareUpdateError ? error.restarted : false} error=${message}`,
      );
      setUsbError(message);
    } finally {
      // Never restart an incompletely written flash here. The transaction only
      // restarts after update verification or verified rollback.
      try { if (device?.opened) await device.releaseInterface(interfaceNumber); } catch {}
      try { if (device?.opened) await device.close(); } catch {}
      setJtagBusy(false);
    }
  }

  async function createReadOnlyFullFlashBackup() {
    const created = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `shapeshifter-full-flash-read-only-${created}.bin`;
    setUsbError("");
    setJtagBusy(true);
    updateFirmwareProgress(0);
    setFullFlashBackupName("");
    lastFirmwareStage.current = null;
    appendDiagnostic("flash.backup.readonly.start");
    let device: any = null;
    let interfaceNumber = 0;
    let jtag: UsbBlasterJtag | null = null;
    let bridgeLoaded = false;
    try {
      const session = await openJtagSession();
      ({ device, interfaceNumber, jtag } = session);
      setStatus("Verifying the Shapeshifter and loading the volatile read-only flash service …");
      const flashSize = await loadFullFlashBridge(jtag, (fraction) => updateFirmwareProgress(fraction * 10));
      bridgeLoaded = true;
      await createVerifiedFullFlashBackup(
        jtag,
        async (bytes) => download(bytes, filename),
        reportFirmwareProgress,
        flashSize,
      );
      setStatus("Both complete flash reads match and the safety copy was downloaded. Restarting …");
      await jtag.restartFromFlash();
      bridgeLoaded = false;
      updateFirmwareProgress(100);
      setFullFlashBackupName(filename);
      setJtagId("");
      setStatus(`Safety copy complete: two matching reads saved as ${filename}; nothing was changed.`);
      appendDiagnostic("flash.backup.readonly.success", `file=${filename} bytes=${flashSize}`);
    } catch (error) {
      if (bridgeLoaded && jtag) {
        try {
          await jtag.restartFromFlash();
          bridgeLoaded = false;
          appendDiagnostic("bridge.restart.after-backup-error", "complete");
        } catch (restartError) {
          appendDiagnostic("bridge.restart.after-backup-error.failed", errorMessage(restartError, "unknown restart error"));
        }
      }
      const message = errorMessage(error, "Read-only full-flash backup failed.");
      appendDiagnostic("flash.backup.readonly.error", `stage=${lastFirmwareStage.current ?? "bridge"} overallPercent=${firmwareProgressValue.current.toFixed(1)} error=${message}`);
      setUsbError(message);
    } finally {
      try { if (device?.opened) await device.releaseInterface(interfaceNumber); } catch {}
      try { if (device?.opened) await device.close(); } catch {}
      setJtagBusy(false);
    }
  }

  async function runFirmwareDryRun() {
    if (!officialFirmware) return;
    setUsbError("");
    setFirmwareDryRunResult("");
    setJtagBusy(true);
    updateFirmwareProgress(0);
    lastFirmwareStage.current = null;
    appendDiagnostic("firmware.dryrun.start", `file=${officialFirmware.filename}`);
    let device: any = null;
    let interfaceNumber = 0;
    let jtag: UsbBlasterJtag | null = null;
    let bridgeLoaded = false;
    try {
      const session = await openJtagSession();
      ({ device, interfaceNumber, jtag } = session);
      setStatus("Loading the volatile read-only flash service …");
      const flashSize = await loadFullFlashBridge(jtag, (fraction) => updateFirmwareProgress(fraction * 10));
      bridgeLoaded = true;
      setStatus("Checking the installed firmware without changing anything …");
      const current = await jtag.readFlash(0, flashSize, (fraction) => updateFirmwareProgress(10 + fraction * 80));
      const { changedSectors } = createJicProgrammingTarget(officialFirmware, current);
      setStatus("Dry run complete. Restarting the Shapeshifter from the unchanged flash …");
      await jtag.restartFromFlash();
      bridgeLoaded = false;
      updateFirmwareProgress(100);
      setFirmwareDryRunResult(changedSectors.length
        ? `${changedSectors.length} of 32 sectors differ. Installation will replace the complete 2 MB firmware memory, including custom wavetables and other stored data.`
        : "This firmware is already installed. No update is needed.");
      setStatus("Firmware dry run complete — no flash write was performed.");
      appendDiagnostic("firmware.dryrun.success", `changedSectors=${changedSectors.length}/32 flashBytes=${flashSize}`);
    } catch (error) {
      if (bridgeLoaded && jtag) {
        try {
          await jtag.restartFromFlash();
          bridgeLoaded = false;
          appendDiagnostic("bridge.restart.after-dryrun-error", "complete");
        } catch (restartError) {
          appendDiagnostic("bridge.restart.after-dryrun-error.failed", errorMessage(restartError, "unknown restart error"));
        }
      }
      const message = errorMessage(error, "Firmware dry run failed.");
      appendDiagnostic("firmware.dryrun.error", `overallPercent=${firmwareProgressValue.current.toFixed(1)} error=${message}`);
      setUsbError(message);
    } finally {
      try { if (device?.opened) await device.releaseInterface(interfaceNumber); } catch {}
      try { if (device?.opened) await device.close(); } catch {}
      setJtagBusy(false);
    }
  }

  async function recoverFullFlash() {
    if (!fullRecoveryBackup) return;
    setUsbError("");
    setJtagBusy(true);
    setFullRecoveryConfirmation("");
    updateFirmwareProgress(0);
    lastFirmwareStage.current = null;
    appendDiagnostic("recovery.start", `file=${fullRecoveryBackup.filename} bytes=${fullRecoveryBackup.bytes.length}`);
    let device: any = null;
    let interfaceNumber = 0;
    let jtag: UsbBlasterJtag | null = null;
    try {
      const session = await openJtagSession();
      ({ device, interfaceNumber, jtag } = session);
      setStatus("Verifying the Shapeshifter and loading the volatile recovery service …");
      const flashSize = await loadFullFlashBridge(jtag, (fraction) => updateFirmwareProgress(fraction * 10));
      if (fullRecoveryBackup.bytes.length !== flashSize) {
        throw new Error("This safety copy belongs to a different flash size. Nothing was changed.");
      }
      await restoreFullFlashBackup(jtag, fullRecoveryBackup.bytes, reportFirmwareProgress);
      updateFirmwareProgress(100);
      setJtagId("");
      setFullRecoveryBackup(null);
      setStatus("Recovery complete: the complete flash matches the safety copy, and the Shapeshifter restarted.");
      appendDiagnostic("recovery.success", `verifiedBytes=${flashSize}; restart complete`);
    } catch (error) {
      const message = errorMessage(error, "Full-flash recovery failed.");
      appendDiagnostic("recovery.error", `stage=${lastFirmwareStage.current ?? "bridge"} overallPercent=${firmwareProgressValue.current.toFixed(1)} error=${message}`);
      setUsbError(message);
    } finally {
      // A failed recovery is deliberately left in the volatile bridge so the
      // user can reconnect and retry without booting an unverified flash.
      try { if (device?.opened) await device.releaseInterface(interfaceNumber); } catch {}
      try { if (device?.opened) await device.close(); } catch {}
      setJtagBusy(false);
    }
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    void loadAudioFiles(Array.from(event.dataTransfer.files));
  }

  return (
    <main>
      <section className="hero" id="top">
        <div>
          <p className="eyebrow">INTELLIJEL SHAPESHIFTER</p>
          <h1>Wavetable Bank Editor</h1>
          <p className="lede">Build a bank, connect your Shapeshifter, create a safety backup, then write the selected bank.<br />A firmware file is not required for normal use.</p>
        </div>
      </section>

      <section className="workspace">
        <div className="panel editor-panel">
          <div className="panel-heading">
            <div><h2>Bank editor</h2></div>
            <span className="file-label">{audioName}</span>
          </div>

          <div className="dropzone" role="button" tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") audioInput.current?.click(); }} onDragOver={(event) => event.preventDefault()} onDrop={handleDrop} onClick={() => audioInput.current?.click()}>
            <input ref={audioInput} type="file" accept="audio/*,.wav,.aif,.aiff" multiple hidden onChange={(event: ChangeEvent<HTMLInputElement>) => void loadAudioFiles(Array.from(event.target.files ?? []))} />
            <span className="drop-icon">↥</span>
            <div><b>Drop audio or up to 8 single cycles</b><small>Multiple files fill W1–W8 · long files follow the selected import mode</small></div>
            <button type="button">Choose files</button>
          </div>

          <div className="import-modes" aria-label="Import mode for long files">
            <span>LONG FILE</span>
            <button type="button" className={importMode === "extract" ? "active" : ""} onClick={() => setImportMode("extract")}>Extract 512-sample windows</button>
            <button type="button" className={importMode === "spread" ? "active" : ""} onClick={() => setImportMode("spread")}>Distribute entire file</button>
            <button className="random-bank-button" type="button" onClick={makeRandomBank}>↻ Generate Wavetable Set</button>
          </div>

          <div className="wave-grid">
            {bank.map((wave, index) => (
              <div
                className={`wave-tile ${selectedWave === index ? "active" : ""} ${waveDropTarget === index ? "drop-target" : ""}`}
                key={index}
                onDragEnter={(event) => { event.preventDefault(); setWaveDropTarget(index); }}
                onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; }}
                onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setWaveDropTarget(null); }}
                onDrop={(event) => { event.preventDefault(); event.stopPropagation(); void loadWaveFiles(Array.from(event.dataTransfer.files), index); }}
              >
                <span>W{index + 1}</span>
                <WaveCanvas wave={wave} active={selectedWave === index} onClick={() => setSelectedWave(index)} />
                {waveDropTarget === index && <b className="wave-drop-label">WAV → W{index + 1}</b>}
              </div>
            ))}
          </div>

          <div className="controls-row">
            <label>Bank slot<select value={bankSlot} onChange={(event) => { setBankSlot(Number(event.target.value)); setBackup(null); setWriteReviewOpen(false); }}>
              {Array.from({ length: BANK_COUNT }, (_, index) => <option key={index} value={index}>{String(index + 1).padStart(3, "0")}</option>)}
            </select></label>
            <label>Display name<input value={bankName} maxLength={6} onChange={(event) => setBankName(event.target.value.toUpperCase())} /></label>
          </div>
        </div>

        <aside className="disclaimer" role="note" aria-label="Hardware risk disclaimer">
          <div><b>⚠ USE AT YOUR OWN RISK</b><span>Experimental, unofficial software. No responsibility is accepted for data loss, malfunction, hardware damage, or a bricked module. WavePort is not affiliated with, authorized by, or endorsed by Intellijel Designs Inc.</span></div>
        </aside>

        <section className="panel usb-section">
        <div className="usb-copy">
          <p className="eyebrow">SHAPESHIFTER</p>
          <h2>Connection</h2>
          <p>Connect the Shapeshifter, check the connection, and create a safety backup before writing a bank.</p>
          <div className="compat"><span className={webUsbAvailable ? "ok" : "no"}>{webUsbAvailable ? "✓ Browser ready" : "× Browser unsupported"}</span><span>Chrome / Edge</span><span>macOS · Windows · Linux</span></div>
        </div>
        <div className="device-card">
          <div className="device-top"><span className={`device-dot ${usb ? "connected" : ""}`} /><b>{usb ? "Shapeshifter connected" : "Shapeshifter not connected"}</b></div>
          {usb ? <details className="connection-details"><summary>Connection details</summary><dl>
            <div><dt>Product</dt><dd>{usb.product}</dd></div>
            <div><dt>USB ID</dt><dd>{usb.vendorId.toString(16).padStart(4, "0")}:{usb.productId.toString(16).padStart(4, "0")}</dd></div>
            <div><dt>Interface</dt><dd>{usb.interfaces} · {usb.endpoints}</dd></div>
            <div><dt>Serial</dt><dd>{usb.serial}</dd></div>
          </dl></details> : <div className="module-silhouette"><div className="screen">SHAPESHIFTER</div><i /><i /><i /><i /></div>}
          {usbError && <p className="usb-error">{usbError}</p>}
          <button className="wide connect" type="button" onClick={connectUsb}>{usb ? "Shapeshifter" : "Connect Shapeshifter"}</button>
          {usb && <button className="wide jtag-button" type="button" disabled={jtagBusy} onClick={scanJtagId}>{jtagBusy ? "Checking connection …" : jtagId ? "✓ Shapeshifter verified" : "Check Shapeshifter"}</button>}
          <div className={`flash-lock ${jtagId ? "passed" : ""}`}><span>{jtagId ? "✓" : "⌁"}</span><div><b>{jtagId ? "Shapeshifter verified" : "Writing unavailable"}</b><small>{jtagId ? "Next, create a safety backup." : "Check the Shapeshifter before continuing."}</small></div></div>
          {jtagId && <button className="wide backup-button" type="button" disabled={jtagBusy} onClick={createFlashBackup}>{jtagBusy ? "Shapeshifter busy …" : backup ? "✓ Create a new safety backup" : "Create safety backup"}</button>}
          {jtagBusy && backupProgress > 0 && backupProgress < 100 && <div className="backup-progress" aria-label={`Backup ${Math.round(backupProgress)} percent`}><i style={{ width: `${backupProgress}%` }} /></div>}
          {backup && <div className="backup-downloads">
            <b>Bank {bankSlot + 1} safety backup ready</b>
            <small>Keep this file until the new bank has been tested.</small>
            <button type="button" onClick={() => download(packBackup(backup, bankSlot), `waveport-bank-${bankSlot + 1}-${backup.created}.backup`)}>Download bank {bankSlot + 1} backup ↓</button>
          </div>}
          <input ref={restoreInput} type="file" accept=".backup,application/octet-stream" hidden onChange={(event) => {
            const file = event.target.files?.[0];
            event.currentTarget.value = "";
            if (file) void loadRestoreBackup(file);
          }} />
          {jtagId && <button className="wide restore-button" type="button" disabled={jtagBusy} onClick={() => restoreInput.current?.click()}>Restore a downloaded bank backup</button>}
          {restoreBackup && <div className="restore-review">
            <b>Restore bank {restoreBackup.bankSlot + 1} “{restoreBackup.bankName}”</b>
            <p>File: {restoreBackup.filename}. Only bank {restoreBackup.bankSlot + 1} and its display name will be restored. The other seven banks in the same flash sector and all other names will remain unchanged.</p>
            <label>Type exactly to unlock<input value={restoreConfirmation} onChange={(event) => setRestoreConfirmation(event.target.value)} placeholder={`RESTORE BANK ${restoreBackup.bankSlot + 1}`} autoComplete="off" /></label>
            <div><button type="button" onClick={() => { setRestoreBackup(null); setRestoreConfirmation(""); }}>Cancel</button><button className="confirm-restore" type="button" disabled={jtagBusy || restoreConfirmation !== `RESTORE BANK ${restoreBackup.bankSlot + 1}`} onClick={restoreBankBackup}>Restore now</button></div>
          </div>}
          {restoreProgress > 0 && restoreProgress < 100 && <div className="restore-progress" aria-label={`Restoring ${Math.round(restoreProgress)} percent`}><i style={{ width: `${restoreProgress}%` }} /></div>}
          {backup && !writeReviewOpen && <button className="wide write-button" type="button" disabled={jtagBusy} onClick={() => { setWriteConfirmation(""); setWriteReviewOpen(true); }}>{jtagBusy && writeProgress > 0 ? `Writing / verify … ${Math.round(writeProgress)} %` : `Write bank ${bankSlot + 1} safely`}</button>}
          {backup && writeReviewOpen && <div className="write-review">
            <b>Final confirmation</b>
            <p>Bank {bankSlot + 1} will be replaced by “{bankName || "BANK"}”. The new bank and its display name will be written, checked, and then loaded by the Shapeshifter.</p>
            <label>Type exactly to unlock<input value={writeConfirmation} onChange={(event) => setWriteConfirmation(event.target.value)} placeholder={`WRITE SLOT ${bankSlot + 1}`} autoComplete="off" /></label>
            <div><button type="button" onClick={() => setWriteReviewOpen(false)}>Cancel</button><button className="confirm-write" type="button" disabled={writeConfirmation !== `WRITE SLOT ${bankSlot + 1}`} onClick={writeBankToFlash}>Write now</button></div>
          </div>}
          {writeProgress > 0 && writeProgress < 100 && <div className="write-progress" aria-label={`Writing ${Math.round(writeProgress)} percent`}><i style={{ width: `${writeProgress}%` }} /></div>}
          {jtagId && <details className="emergency-tools">
            <summary>Full-flash backup &amp; recovery</summary>
            <div className="emergency-body">
              <p>Firmware installation writes the complete, unmodified 2 MB image extracted from the selected official JIC. Custom wavetables, presets, and other data in that region will be replaced.</p>
              <button className="wide read-only-backup-button" type="button" disabled={jtagBusy} onClick={() => void createReadOnlyFullFlashBackup()}>Create complete safety copy — no changes</button>
              {fullFlashBackupName && <div className="full-flash-file"><b>✓ Safety copy verified</b><small>{fullFlashBackupName} · two matching reads · nothing changed</small></div>}
              {!FIRMWARE_WRITES_ENABLED && <div className="full-flash-file"><b>Firmware installation unavailable</b><small>Use the official Quartus Programmer for firmware updates.</small></div>}
              {FIRMWARE_WRITES_ENABLED && <>
                <input ref={officialFirmwareInput} type="file" hidden onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.currentTarget.value = "";
                  if (file) void loadOfficialFirmware(file);
                }} />
                <button className="wide secondary" type="button" disabled={jtagBusy} onClick={() => officialFirmwareInput.current?.click()}>{officialFirmware ? "Choose different firmware file" : "Choose official Shapeshifter firmware"}</button>
                {officialFirmware && <div className="full-flash-file"><b>✓ Official firmware verified</b><small>{officialFirmware.filename}</small></div>}
                {officialFirmware && <button className="wide read-only-backup-button" type="button" disabled={jtagBusy} onClick={() => void runFirmwareDryRun()}>Check what the update would change — read only</button>}
                {firmwareDryRunResult && <div className="full-flash-file"><b>✓ Update check completed</b><small>{firmwareDryRunResult}</small></div>}
                {officialFirmware && <div className="firmware-review">
                  <b>⚠ Firmware update</b>
                  <p>A fresh complete safety copy is saved first. The entire extracted 2 MB image is then written, including blank sectors, and checked byte-for-byte before restarting.</p>
                  <label>Type exactly to confirm<input value={firmwareConfirmation} onChange={(event) => setFirmwareConfirmation(event.target.value)} placeholder="UPDATE FIRMWARE" autoComplete="off" /></label>
                  <div><button type="button" onClick={() => setOfficialFirmware(null)}>Cancel</button><button className="confirm-firmware" type="button" disabled={jtagBusy || firmwareConfirmation !== "UPDATE FIRMWARE"} onClick={() => void testOfficialFirmware()}>Update firmware safely</button></div>
                </div>}
              </>}

              <input ref={fullRecoveryInput} type="file" accept=".bin,application/octet-stream" hidden onChange={(event) => {
                const file = event.target.files?.[0];
                event.currentTarget.value = "";
                if (file) void loadFullRecoveryBackup(file);
              }} />
              <button className="wide full-recovery-button" type="button" disabled={jtagBusy} onClick={() => fullRecoveryInput.current?.click()}>Restore a complete safety copy</button>
              {fullRecoveryBackup && <div className="firmware-review recovery">
                <b>Restore original state: {fullRecoveryBackup.filename}</b>
                <p>The saved firmware area is restored and the complete device is then checked against this same safety copy. Personal data in the backup are preserved exactly.</p>
                <label>Type exactly to unlock<input value={fullRecoveryConfirmation} onChange={(event) => setFullRecoveryConfirmation(event.target.value)} placeholder="RECOVER ORIGINAL FLASH" autoComplete="off" /></label>
                <div><button type="button" onClick={() => setFullRecoveryBackup(null)}>Cancel</button><button className="confirm-recovery" type="button" disabled={jtagBusy || fullRecoveryConfirmation !== "RECOVER ORIGINAL FLASH"} onClick={() => void recoverFullFlash()}>Recover &amp; verify</button></div>
              </div>}
              {firmwareProgress > 0 && firmwareProgress < 100 && <div className="firmware-progress" aria-label={`Firmware operation ${Math.round(firmwareProgress)} percent`}><i style={{ width: `${firmwareProgress}%` }} /></div>}
            </div>
          </details>}
          <details className="emergency-tools diagnostic-tools">
            <summary>Diagnostic log</summary>
            <div className="emergency-body">
              <p>The update log is stored only in this browser and survives a page reload. Download the text file to send it with a support request. Flash contents, file contents, audio, and the USB serial number are never included.</p>
              <div className="full-flash-file"><b>{diagnosticEntries.length} local log entries</b><small>{diagnosticEntries.at(-1)?.event ?? "No events recorded"}</small></div>
              <button className="wide diagnostic-download-button" type="button" disabled={diagnosticEntries.length === 0} onClick={downloadDiagnosticLog}>Download diagnostic log</button>
              <button className="wide secondary" type="button" disabled={diagnosticEntries.length === 0 || jtagBusy} onClick={clearDiagnosticLog}>Clear diagnostic log</button>
            </div>
          </details>
        </div>
        <div className="status-line" aria-live="polite"><span />{status}</div>
        </section>
      </section>

      <footer><span>WAVEPORT {APP_VERSION} / EXPERIMENTAL HARDWARE TOOL</span><span>No files are uploaded.</span></footer>
    </main>
  );
}
