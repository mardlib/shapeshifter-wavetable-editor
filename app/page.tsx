import type { Metadata } from "next";
import ShapeshifterStudio from "./ShapeshifterStudio";

export const metadata: Metadata = {
  title: "WavePort — Shapeshifter Wavetable Studio",
  description:
    "Create, patch, back up and diagnose Intellijel Shapeshifter wavetable firmware locally in your browser.",
};

export default function Home() {
  return <ShapeshifterStudio />;
}
