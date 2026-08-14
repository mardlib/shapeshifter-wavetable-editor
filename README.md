# Shapeshifter Wavetable Bank Editor

[**Open the Shapeshifter Wavetable Bank Editor**](https://mardlib.github.io/shapeshifter-wavetable-editor/)

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
- Generate a wild but related random bank with moving formants, phase warping,
  drive, and wave folding across its eight waves.
- Preview all eight waves and choose any of the 128 bank slots.
- Connect to the Shapeshifter from Chrome or Edge on macOS, Windows, or Linux.
- Create one downloadable safety-backup file for the selected bank.
- Restore a downloaded bank backup in a later session without changing the
  other seven banks stored in the same flash sector.
- Write and verify the selected bank, with automatic in-session rollback if a
  write check fails.
- Load either an exact 2 MB raw firmware image or the official Shapeshifter
  EPCS16 `.jic`; compatible JIC containers are validated before their embedded
  flash image is extracted locally for creating a patched `.bin` copy.

The app deliberately does not offer full-firmware flashing. That path has not
been validated on hardware and should be performed with a supported external
programmer instead.

All audio conversion and firmware processing happens locally in the browser.
No files are uploaded by the application.

## Requirements

- Intellijel Shapeshifter
- Compatible USB service/programming connection
- Desktop Chrome or Edge with WebUSB support
- A data-capable USB cable

Safari and Firefox do not currently expose the WebUSB API required by this
tool.

## Normal workflow

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
