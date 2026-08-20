export function usbBlasterReadRequestLength(payloadLength: number) {
  // Full-speed FTDI packets contain two modem-status bytes followed by at
  // most 62 payload bytes. WebUSB reports `babble` if the device returns a
  // complete 64-byte packet into a shorter request buffer.
  return Math.min(16384, Math.max(64, Math.ceil(payloadLength / 62) * 64));
}
