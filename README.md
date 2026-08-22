# Shapeshifter Wavetable Bank Editor

[**Open the Shapeshifter Wavetable Bank Editor**](https://mardlib.github.io/shapeshifter-wavetable-editor/)

**Current version: 0.3.2** · [Release notes](RELEASE_NOTES.md) · [All GitHub releases](https://github.com/mardlib/shapeshifter-wavetable-editor/releases)

### What changed in 0.3.2

- Retries complete flash-read blocks after recoverable WebUSB errors in either
  direction, including the macOS `transferOut` failure seen during backup verification.
- Clears both USB endpoint halts and both FTDI buffers before resetting JTAG and
  repeating the block, preventing partial commands or replies from being reused.
- Records every retry, flash address, and recovery warning in the diagnostic log.

![Shapeshifter Wavetable Bank Editor](docs/screenshot.jpg)

A browser-based tool for creating and writing custom wavetable banks to an
Intellijel Shapeshifter through its USB service connection. The normal workflow
does not require a firmware image or a platform-specific application.

> [!WARNING]
> This is experimental, unofficial software. Using it can cause data loss,
> malfunction, hardware damage, or a bricked module. Use it entirely at your
> own risk, keep a verified backup, and provide stable power while writing.
>
> This project is not affiliated with, authorized by, or endorsed by Intellijel
> Designs Inc.

## Features

- Import one audio file, up to eight single-cycle WAV files, or drag a file onto
  an individual wave slot.
- Extract consecutive 512-sample waves or distribute a longer recording across
  a bank.
- Generate a varied but related random set with moving formants, phase warping,
  drive, and wave folding across its eight waves.
- Preview all eight waves and choose any of the 128 bank slots.
- Connect to the Shapeshifter from Chrome or Edge on macOS, Windows, or Linux.
- Install WavePort as an app and use it without an internet connection.
- Create one downloadable safety-backup file for the selected bank.
- Restore a downloaded bank backup in a later session without changing the
  other seven banks stored in the same flash sector.
- Write and verify the selected bank, with automatic in-session rollback if a
  write check fails.
- Create a verified complete read-only flash backup.
- Install an official Shapeshifter JIC as a complete, unmodified 2 MB image.
- Load a saved full-flash dump for exact byte-for-byte recovery.

All audio conversion and bank processing happens locally in the browser.
No files are uploaded by the application.

## Diagnostic log

Open **Diagnostic log** in the connection panel and select **Download diagnostic
log** to save a shareable `.txt` file. The log is retained in that browser across
page reloads, so it remains available after an update error. It contains timestamps,
the WavePort and browser versions, detected FPGA/EPCS information, firmware-operation
stages, USB read retries, verification results, restart attempts, and automatic
recovery results.

The diagnostic log is never uploaded. It does not contain flash contents, imported
audio, firmware or backup file contents, or the USB device serial number. **Clear
diagnostic log** removes the locally stored history.

## Requirements

- Intellijel Shapeshifter
- Compatible USB service/programming connection
- Desktop Chrome or Edge with WebUSB support
- A data-capable USB cable

Safari and Firefox do not currently expose the WebUSB API required by this
tool.

## Install for offline use

Open the hosted WavePort page once in desktop Chrome or Edge, then choose the
browser's **Install WavePort** action. The installed app opens in its own window
and keeps the complete interface and Shapeshifter USB bridge available offline.

An internet connection is only needed for the initial installation and to
receive future updates. USB access and all audio processing remain local.

## Write a wavetable bank

1. Import or generate a bank.
2. Select the destination bank and display name.
3. Connect the Shapeshifter.
4. Check the Shapeshifter connection.
5. Create and download the safety backup.
6. Confirm the destination bank and write it.
7. Let the write and verification finish without disconnecting power or USB.

The downloadable `.backup` file contains the original bank-name data and the
complete eight-bank flash block containing the selected bank. Keep it until the
new bank has been tested. To restore it later, verify the Shapeshifter, choose
**Restore a downloaded bank backup**, load the file, and enter the displayed
confirmation phrase. The restore process copies only the bank and name recorded
in the file, verifies both, and leaves neighboring banks unchanged.

Writing one wavetable bank does not require a JIC firmware file and does not
replace the whole firmware area. A WavePort `.backup` is a bank-level backup;
it is different from the complete `.bin` safety copy used for firmware recovery.

## Update or downgrade the firmware

WavePort accepts only a validated Shapeshifter `.jic` file. Download the desired
official firmware from Intellijel; do not rename a raw binary to `.jic`. WavePort
extracts the JIC's 2 MB image without modifying or patching it. WavePort itself is
a custom, unofficial programmer and does not claim to reproduce Quartus's exact
USB/JTAG command sequence.

> [!IMPORTANT]
> A complete firmware installation replaces all 32 sectors in the first 2 MB,
> including sectors filled with `FF`. Existing custom wavetables, presets, and
> any other data stored there will be replaced. Flash beyond the official 2 MB
> JIC area is preserved. Keep the automatically created complete safety copy.

1. Download the official Shapeshifter JIC you want to install.
2. Open WavePort in desktop Chrome or Edge and connect the USB service cable.
3. Select **Check Shapeshifter**.
4. Open **Full-flash backup & recovery**.
5. Select **Choose official Shapeshifter firmware** and choose the `.jic` file.
6. Optionally run **Check what the update would change — read only**.
7. Enter `UPDATE FIRMWARE` and select **Update firmware safely**.
8. Choose a permanent location for the automatically created complete `.bin`
   safety copy. The firmware write will not start unless that file is saved.
9. Leave USB and Eurorack power connected until WavePort reports that verification
   and restart are complete. The module may be silent with its LEDs lit while the
   temporary programming bridge is active; this is expected.
10. Test controls and audio. To display the installed version, enter PRESET MODE,
    hold **DETUNE**, and press **LOAD**.

The safety copy is read twice and both reads must match. After writing, WavePort
reads the complete fitted flash and requires this separate comparison:

```text
first 2 MB after update == unmodified image extracted from the selected JIC
flash beyond 2 MB       == same bytes from the pre-update safety copy
```

The FPGA restarts only after the comparison passes. If writing or verification
fails before restart, WavePort automatically restores the original firmware area
and verifies the complete flash against the pre-update safety copy.

### Restore factory presets after a complete update

If the preset list is empty after installing firmware 2.01 or newer:

1. Power the Shapeshifter off.
2. Set the left-most tiny DIP switch on the lower-left of the rear circuit board
   to **UP**.
3. Power on; enter PRESET MODE; press **SAVE**; turn the encoder to `Y?`; press
   **SAVE** again.
4. Power off, return that DIP switch to **DOWN**, and power on again.

This initializes the firmware's factory presets. It does not recover personal
presets or custom wavetables; use the pre-update full-flash safety copy for that.

## Complete backup and recovery

**Create complete safety copy — no changes** detects an EPCS16 (2 MB) or EPCS64
(8 MB), reads the whole fitted flash twice, requires identical reads, and downloads
the matching `.bin`. Nothing is written during this operation.

If a newly installed image passed verification but the module does not boot, the
saved pre-update dump remains usable because JTAG recovery does not depend on that
image booting:

1. Reconnect and select **Check Shapeshifter**.
2. Open **Full-flash backup & recovery**.
3. Select **Restore a complete safety copy** and load the exact pre-update `.bin`.
4. Enter `RECOVER ORIGINAL FLASH` and select **Recover & verify**.
5. Keep USB and power connected until verification and restart finish.

Recovery uses a different comparison from firmware installation:

```text
complete flash after recovery == original pre-update full-flash dump
```

The old dump is never compared with the new official image. It is a byte-for-byte
snapshot of the original state, including personal wavetables, presets, calibration,
firmware, and every other recorded byte.

## Hardware validation

The 0.3.0 flow was tested on a physical Shapeshifter with an 8 MB EPCS64:

- complete flash backup using two identical 8 MB reads;
- complete downgrade using the official, unmodified 2.01.1 JIC image;
- full-flash readback verification and successful restart as firmware 2.01;
- normal WavePort wavetable-bank write on 2.01;
- complete installation of the official, unmodified 2.04 JIC image;
- full verification, successful restart, controls, display, and audio.

The test confirms the resulting logical flash image, not equivalence with every
internal command used by Intel Quartus or compatibility with every hardware revision.
WavePort remains unofficial experimental software.

## Versioning

WavePort follows semantic versioning: major versions may introduce incompatible
workflows or file formats, minor versions add functionality, and patch versions
contain compatible fixes. The version in this README, `package.json`, GitHub tag,
and GitHub release should match. Detailed history is kept in
[RELEASE_NOTES.md](RELEASE_NOTES.md).

## Local development

Requires Node.js 22.13 or newer.

```bash
npm install
npm run dev
```

Open the local address printed by the development server.

Useful checks:

```bash
npm run lint
npm test
npm run build:pages
```

`npm run build:pages` creates the static GitHub Pages site in `dist-pages/`.

## GitHub Pages

The current static build is published from the `gh-pages` branch:

https://mardlib.github.io/shapeshifter-wavetable-editor/

To publish an updated build, run `npm run build:pages` and deploy the contents
of `dist-pages/` to that branch.

WebUSB requires a secure context; the HTTPS URL provided by GitHub Pages meets
that browser requirement.

## Credits

The USB programming and SPI-over-JTAG implementation is adapted from
[openFPGALoader](https://github.com/trabucayre/openFPGALoader), licensed under
Apache License 2.0. The included volatile FPGA bridge and attribution details
are documented in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

WavePort's original source code is released under the [MIT License](LICENSE).
Bundled third-party material remains under its respective license.
