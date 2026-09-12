"""Synthesize one WAV file with Piper TTS."""

import argparse
import os
import sys
import wave
from pathlib import Path

from piper import PiperVoice, SynthesisConfig


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True, type=Path)
    parser.add_argument("--output_file", required=True, type=Path)
    parser.add_argument("--length_scale", type=float, default=1.0)
    parser.add_argument("--noise_scale", type=float, default=0.667)
    parser.add_argument("--noise_w", type=float, default=0.8)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    text = sys.stdin.buffer.read().decode("utf-8", errors="replace").strip()
    text = "".join(char for char in text if not 0xD800 <= ord(char) <= 0xDFFF)
    args.output_file.parent.mkdir(parents=True, exist_ok=True)

    voice = PiperVoice.load(str(args.model))
    synthesis_config = SynthesisConfig(
        length_scale=args.length_scale,
        noise_scale=args.noise_scale,
        noise_w_scale=args.noise_w,
    )

    with wave.open(str(args.output_file), "wb") as wav_file:
        voice.synthesize_wav(text, wav_file, syn_config=synthesis_config)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
