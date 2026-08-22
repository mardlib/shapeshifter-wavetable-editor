# WavePort 0.3.2

## Bidirectional WebUSB read recovery

- Retries a complete 1 KB flash-read block after recoverable `transferOut` as
  well as `transferIn` failures.
- Clears both USB endpoint halts and purges both FTDI buffers before resetting
  the JTAG state, so partial commands and replies are never continued.
- Covers the repeated macOS failure reported during the second safety-backup read,
  before any firmware write had begun.
- Logs the retry address, attempt, original USB error, and recovery warnings.

# WavePort 0.3.1

## Downloadable local diagnostics

- Keeps a timestamped firmware-operation log in browser storage across reloads.
- Records application/browser versions, FPGA and EPCS detection, stage changes,
  recoverable USB read retries, verification, restart, errors, and rollback state.
- Adds a visible diagnostic panel that downloads the history as a shareable text
  file or clears it locally.
- Excludes flash contents, audio, firmware and backup contents, and USB serial
  numbers; nothing is uploaded.

# WavePort 0.3.0

## Complete-image firmware installation

- Re-enables firmware installation after physical downgrade, wavetable-write,
  upgrade, restart, display, control, and audio testing.
- Accepts only a validated Shapeshifter JIC and writes its extracted, unmodified
  2 MB image in full, including blank/`FF` sectors.
- Removes the earlier sparse-JIC behavior; firmware installation now replaces all
  32 sectors in the official 2 MB region while preserving fitted flash beyond it.
- Reads the complete EPCS16 or EPCS64 twice and permanently saves the matching
  pre-update dump before any firmware write.
- Reads the complete fitted flash after installation and verifies the new 2 MB
  image plus every preserved byte before restarting the FPGA.
- Automatically restores the original 2 MB region and verifies the complete flash
  against the pre-update dump after a write or pre-restart verification failure.
- Keeps manual recovery from that same complete dump available if a verified image
  does not boot after restart.
- Retries complete 1 KB read blocks after recoverable WebUSB transfer errors so a
  partial or shifted USB response can never be accepted as flash data.
- Documents firmware updates, factory-preset initialization, wavetable writes,
  backup/recovery, hardware validation, and versioning in the README.

### Hardware validation

Tested on one physical EPCS64 Shapeshifter with official, unmodified Intellijel
JIC files: complete downgrade to 2.01.1, version confirmation, normal wavetable
write, and complete return to 2.04. Both firmware installations passed full-flash
byte-for-byte verification before restart; display, controls, and audio worked.

WavePort uses a custom USB/JTAG programmer. This test verifies the resulting flash
contents and module operation; it does not claim identical internal commands to
Intel Quartus or validation across every hardware revision.

# WavePort 0.2.3

## Firmware installation disabled

- Removes firmware installation controls from the public interface.
- Adds a hard runtime guard that prevents the experimental sparse-JIC writer from running.
- Keeps complete read-only flash backup and exact byte-for-byte recovery available.
- Directs firmware updates to the official Quartus Programmer until compatible JIC programming semantics are verified.

## WavePort 0.2.2

## Clearer firmware confirmation and visible version history

- Changes the firmware confirmation phrase from `TEST FULL FIRMWARE` to the clearer `UPDATE FIRMWARE`.
- Shows the current version, latest changes, and release links prominently in the README.

## WavePort 0.2.1

## Compatibility and clearer operation

- Automatically supports both older 2 MB and newer 8 MB DE0-Nano flash chips.
- Removes the separate capacity-probe tool; detection now happens automatically.
- Rewrites the firmware and recovery screens in plain language while keeping technical details out of the main workflow.

## WavePort 0.2.0

## Safe Shapeshifter firmware update and recovery

- Validates official EP4CE22/EPCS16 JIC files and extracts their 2 MB flash payload in correct bit order.
- Reads the complete fitted flash twice and requires a persistent matching backup before firmware writes.
- Treats the JIC as a sparse programming image: blank/unassigned sectors remain untouched.
- Writes only populated JIC sectors that differ from the installed flash.
- Reads the complete flash back before restart, verifying JIC targets and every preserved byte separately.
- Automatically restores and verifies the original 2 MB region if writing or pre-boot verification fails.
- Supports later manual 1:1 recovery from the saved full-flash dump.
- Adds a read-only JIC dry run that reports exactly which sectors would change.
- Speeds up full-flash reads by batching USB-Blaster transfers safely.

The v0.2.0 sparse-sector flow was tested with the official Shapeshifter v2.04 JIC on physical hardware. Six sectors changed, the complete 8 MB readback passed, and the module rebooted with normal display, controls, and audio.

Firmware access remains experimental. Keep the complete pre-update backup even after a successful restart.
