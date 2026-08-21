import type { Metadata } from "next";
import ShapeshifterStudio from "./ShapeshifterStudio";

export const metadata: Metadata = {
  title: "WavePort — Shapeshifter Wavetable Studio",
  description:
    "Create and write Shapeshifter wavetable banks, make complete backups, and safely install official JIC firmware locally in your browser.",
};

export default function Home() {
  return <ShapeshifterStudio />;
}
