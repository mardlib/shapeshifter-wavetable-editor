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
