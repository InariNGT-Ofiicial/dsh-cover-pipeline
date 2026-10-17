"""Uniform pitch shift for accompaniment and harmony.

Clean replacement for the song-specific p55 helper: same K for both tracks,
FLOAT output (never hard-clips), no hardcoded project paths.
"""
import argparse
import os
import sys

import numpy as np
import soundfile as sf
from pedalboard import Pedalboard, PitchShift


def shift(y, sr, semitones):
    if abs(semitones) < 1e-9:
        return y.copy()
    board = Pedalboard([PitchShift(semitones=float(semitones))])
    x = np.ascontiguousarray(y.T.astype(np.float32))
    return np.asarray(board(x, sr), dtype=np.float32).T


def run(src, dst, semitones, subtype):
    y, sr = sf.read(src, dtype="float32", always_2d=True)
    out = shift(y, sr, semitones)
    n = min(len(out), len(y))
    sf.write(dst, out[:n], sr, subtype=subtype)
    print(f"  {os.path.basename(src)} -> {os.path.basename(dst)}  k={semitones:+g}  "
          f"{len(out[:n]) / sr:.2f}s  peak={float(np.max(np.abs(out[:n]))):.4f}", flush=True)


def main():
    ap = argparse.ArgumentParser(description="Shift accompaniment and harmony by the same K.")
    ap.add_argument("key", type=float, help="semitones, e.g. 5 or -3")
    ap.add_argument("--inst-src", required=True)
    ap.add_argument("--harm-src", required=True)
    ap.add_argument("--outdir", required=True)
    ap.add_argument("--subtype", default="FLOAT", choices=["FLOAT", "PCM_24", "PCM_16"])
    args = ap.parse_args()
    os.makedirs(args.outdir, exist_ok=True)
    run(args.inst_src, os.path.join(args.outdir, "inst.wav"), args.key, args.subtype)
    run(args.harm_src, os.path.join(args.outdir, "harm.wav"), args.key, args.subtype)


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    main()
