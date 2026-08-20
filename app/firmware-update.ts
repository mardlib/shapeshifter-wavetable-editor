import type { FirmwareImage } from "./shapeshifter-core";

export const FIRMWARE_REGION_SIZE = 2 * 1024 * 1024;
export const PHYSICAL_FLASH_SIZE = 8 * 1024 * 1024;
export const FLASH_SECTOR_SIZE = 0x10000;
export const FIRMWARE_SECTOR_COUNT = FIRMWARE_REGION_SIZE / FLASH_SECTOR_SIZE;

export type FullFlashDevice = {
  readFlash(address: number, length: number, onProgress?: (fraction: number) => void): Promise<Uint8Array>;
  writeFlashSector(address: number, data: Uint8Array, onProgress?: (fraction: number) => void): Promise<void>;
  restartFromFlash(): Promise<void>;
};

export type FirmwareStage =
  | "backup-read"
  | "backup-confirm"
  | "backup-save"
  | "update-write"
  | "update-verify"
  | "rollback-write"
  | "rollback-verify"
  | "recovery-write"
  | "recovery-verify"
  | "restart";

export type FirmwareProgress = (stage: FirmwareStage, fraction: number) => void;

export class FirmwareUpdateError extends Error {
  readonly rollbackVerified: boolean;
  readonly restarted: boolean;

  constructor(message: string, rollbackVerified: boolean, restarted: boolean) {
    super(message);
    this.name = "FirmwareUpdateError";
    this.rollbackVerified = rollbackVerified;
    this.restarted = restarted;
  }
}

export function equalBytes(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  return true;
}

function requireFirmwareImage(image: Uint8Array, label: string) {
  if (image.length !== FIRMWARE_REGION_SIZE) {
    throw new Error(`${label} must be exactly ${FIRMWARE_REGION_SIZE.toLocaleString("en-US")} bytes.`);
  }
}

function requirePhysicalFlashBackup(image: Uint8Array, label: string) {
  if (image.length !== PHYSICAL_FLASH_SIZE) {
    throw new Error(`${label} must be exactly ${PHYSICAL_FLASH_SIZE.toLocaleString("en-US")} bytes.`);
  }
}

async function readPhysicalFlash(device: FullFlashDevice, onProgress?: (fraction: number) => void) {
  return device.readFlash(0, PHYSICAL_FLASH_SIZE, onProgress);
}

async function writeJicSectors(
  device: FullFlashDevice,
  image: FirmwareImage,
  sectors: number[],
  onProgress?: (fraction: number) => void,
) {
  requireFirmwareImage(image.bytes, "Firmware image");
  for (let index = 0; index < sectors.length; index++) {
    const sector = sectors[index];
    const address = sector * FLASH_SECTOR_SIZE;
    await device.writeFlashSector(
      address,
      image.bytes.subarray(address, address + FLASH_SECTOR_SIZE),
      (fraction) => onProgress?.((index + fraction) / sectors.length),
    );
  }
}

export function createJicProgrammingTarget(image: FirmwareImage, backup: Uint8Array) {
  requireFirmwareImage(image.bytes, "Firmware image");
  requirePhysicalFlashBackup(backup, "Physical-flash backup");
  if (image.format !== "JIC") throw new Error("Safe firmware update requires a validated JIC programming file.");
  const unique = new Set(image.programmedSectors);
  if (unique.size !== image.programmedSectors.length
    || image.programmedSectors.some((sector) => !Number.isInteger(sector) || sector < 0 || sector >= FIRMWARE_SECTOR_COUNT)) {
    throw new Error("Rejected: the JIC programming-sector map is invalid.");
  }
  const target = new Uint8Array(backup);
  const changedSectors: number[] = [];
  for (const sector of image.programmedSectors) {
    const start = sector * FLASH_SECTOR_SIZE;
    const desired = image.bytes.subarray(start, start + FLASH_SECTOR_SIZE);
    if (!equalBytes(backup.subarray(start, start + FLASH_SECTOR_SIZE), desired)) changedSectors.push(sector);
    target.set(desired, start);
  }
  return { target, changedSectors };
}

async function writeFirmwareRegion(
  device: FullFlashDevice,
  image: Uint8Array,
  onProgress?: (fraction: number) => void,
) {
  requireFirmwareImage(image, "Firmware-region image");
  for (let sector = 0; sector < FIRMWARE_SECTOR_COUNT; sector++) {
    const address = sector * FLASH_SECTOR_SIZE;
    await device.writeFlashSector(
      address,
      image.subarray(address, address + FLASH_SECTOR_SIZE),
      (fraction) => onProgress?.((sector + fraction) / FIRMWARE_SECTOR_COUNT),
    );
  }
}

export async function createVerifiedFullFlashBackup(
  device: FullFlashDevice,
  persist: (backup: Uint8Array) => Promise<void>,
  progress?: FirmwareProgress,
) {
  progress?.("backup-read", 0);
  const firstRead = await readPhysicalFlash(device, (fraction) => progress?.("backup-read", fraction));
  requirePhysicalFlashBackup(firstRead, "First physical-flash backup read");
  progress?.("backup-confirm", 0);
  const secondRead = await readPhysicalFlash(device, (fraction) => progress?.("backup-confirm", fraction));
  requirePhysicalFlashBackup(secondRead, "Second physical-flash backup read");
  if (!equalBytes(firstRead, secondRead)) {
    throw new Error("Full-flash backup was read twice but the two reads differ. Nothing was written.");
  }
  // Keep the transaction's verified snapshot independent from the byte view
  // handed to browser file APIs, which may transfer or otherwise consume it.
  const verifiedBackup = new Uint8Array(firstRead);
  progress?.("backup-save", 0);
  await persist(new Uint8Array(verifiedBackup));
  progress?.("backup-save", 1);
  return verifiedBackup;
}

export async function restoreFullFlashBackup(
  device: FullFlashDevice,
  backup: Uint8Array,
  progress?: FirmwareProgress,
) {
  requirePhysicalFlashBackup(backup, "Recovery backup");
  progress?.("recovery-write", 0);
  await writeFirmwareRegion(device, backup.subarray(0, FIRMWARE_REGION_SIZE), (fraction) => progress?.("recovery-write", fraction));
  progress?.("recovery-verify", 0);
  const readback = await readPhysicalFlash(device, (fraction) => progress?.("recovery-verify", fraction));
  if (!equalBytes(readback, backup)) {
    throw new Error("Recovery verification failed: flash does not match the original full-flash backup.");
  }
  progress?.("restart", 0);
  await device.restartFromFlash();
  progress?.("restart", 1);
}

export async function runSafeFirmwareUpdate(
  device: FullFlashDevice,
  firmwareImage: FirmwareImage,
  persistBackup: (backup: Uint8Array) => Promise<void>,
  progress?: FirmwareProgress,
) {
  requireFirmwareImage(firmwareImage.bytes, "Firmware image");
  const backup = await createVerifiedFullFlashBackup(device, persistBackup, progress);
  const { target, changedSectors } = createJicProgrammingTarget(firmwareImage, backup);
  const changed = changedSectors.length > 0;

  try {
    if (changed) {
      progress?.("update-write", 0);
      await writeJicSectors(device, firmwareImage, changedSectors, (fraction) => progress?.("update-write", fraction));
      progress?.("update-verify", 0);
      const readback = await readPhysicalFlash(device, (fraction) => progress?.("update-verify", fraction));
      if (!equalBytes(readback, target)) {
        throw new Error("Firmware verification failed: programmed JIC sectors or preserved backup sectors do not match.");
      }
    }
  } catch (updateError) {
    try {
      progress?.("rollback-write", 0);
      await writeFirmwareRegion(device, backup.subarray(0, FIRMWARE_REGION_SIZE), (fraction) => progress?.("rollback-write", fraction));
      progress?.("rollback-verify", 0);
      const recoveryReadback = await readPhysicalFlash(device, (fraction) => progress?.("rollback-verify", fraction));
      if (!equalBytes(recoveryReadback, backup)) {
        throw new Error("automatic recovery readback does not match the original backup");
      }
    } catch (rollbackError) {
      const original = updateError instanceof Error ? updateError.message : "Firmware update failed.";
      const recovery = rollbackError instanceof Error ? rollbackError.message : "unknown recovery error";
      throw new FirmwareUpdateError(
        `${original} CRITICAL: automatic full-flash recovery failed: ${recovery}`,
        false,
        false,
      );
    }
    const original = updateError instanceof Error ? updateError.message : "Firmware update failed.";
    try {
      progress?.("restart", 0);
      await device.restartFromFlash();
      progress?.("restart", 1);
    } catch (restartError) {
      const restart = restartError instanceof Error ? restartError.message : "unknown restart error";
      throw new FirmwareUpdateError(
        `${original} The original full-flash backup was restored and verified, but restart failed: ${restart}`,
        true,
        false,
      );
    }
    throw new FirmwareUpdateError(
      `${original} The original full-flash backup was automatically restored and verified.`,
      true,
      true,
    );
  }

  // Restart is deliberately outside the pre-boot write/verify transaction.
  // A transport error here must not rewrite a firmware image that already
  // passed the complete byte-for-byte readback.
  try {
    progress?.("restart", 0);
    await device.restartFromFlash();
    progress?.("restart", 1);
  } catch (restartError) {
    const restart = restartError instanceof Error ? restartError.message : "unknown restart error";
    throw new FirmwareUpdateError(
      `The JIC programming target passed complete byte-for-byte verification, but restart failed: ${restart}. Keep the saved pre-test dump for manual recovery if the module does not boot.`,
      false,
      false,
    );
  }
  return { backup, changed };
}
