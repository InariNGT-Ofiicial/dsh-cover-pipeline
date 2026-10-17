# -*- coding: utf-8 -*-
"""p87 换声有效性核验：证明"音色确实换了、而音高/时长没被动过"。

口径尽量与 p51_guided.eval_pair 一致（MFCC 用 librosa 默认、均值后取 L2 范数），
这样数值可与 `03_mix/发布信息.md` 里记的 MFCC 距离（61.26）直接对照。

用法: python p87_conv_check.py --dry 换声.wav --ref 源干声.wav [--target 0]
"""
from __future__ import annotations

import argparse
import sys

import numpy as np
import soundfile as sf
import librosa

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

SR = 44100


def rd(p):
    y, sr = sf.read(p, dtype="float32", always_2d=True)
    y = y.mean(axis=1).astype(np.float64)
    if sr != SR:
        y = librosa.resample(y, orig_sr=sr, target_sr=SR)
    return y


def f0_med(y):
    f0, vf, _ = librosa.pyin(y, fmin=65, fmax=1000, sr=SR,
                             frame_length=2048, hop_length=256)
    m = vf & np.isfinite(f0)
    return (float(np.median(f0[m])) if m.sum() > 20 else float("nan")), int(m.sum())


def centroid(y):
    return float(np.mean(librosa.feature.spectral_centroid(y=y, sr=SR)))


def mfcc_vec(y):
    S = np.abs(librosa.stft(y, n_fft=2048, hop_length=512))
    return np.mean(librosa.feature.mfcc(S=librosa.power_to_db(S ** 2), n_mfcc=20), axis=1)


def db(x):
    return 20 * np.log10(max(float(x), 1e-12))


def main():
    ap = argparse.ArgumentParser(description="换声有效性核验")
    ap.add_argument("--dry", required=True, help="换声输出")
    ap.add_argument("--ref", required=True, help="源干声")
    args = ap.parse_args()

    yo, yr = rd(args.dry), rd(args.ref)
    n = min(len(yo), len(yr))
    if abs(len(yo) - len(yr)) > SR * 0.05:
        print("  ⚠ 时长差 %.3f s（超过 50 ms，需查是否切过）" % (abs(len(yo) - len(yr)) / SR))

    fd, nd = f0_med(yo)
    fr, nr = f0_med(yr)
    cd, cr = centroid(yo), centroid(yr)
    md = float(np.linalg.norm(mfcc_vec(yo) - mfcc_vec(yr)))

    print("=" * 72)
    print("换声有效性核验   dry=%s" % args.dry.split("/")[-1])
    print("  %-12s %-14s %-14s %s" % ("", "源干声", "换声输出", "判读"))
    print("  %-12s %-14.2f %-14.2f %s" % ("时长 s", len(yr) / SR, len(yo) / SR,
          "对齐 ✅" if abs(len(yo) - len(yr)) < SR * 0.02 else "★ 不一致"))
    print("  %-12s %-14.2f %-14.2f 差 %+.2f Hz" % ("F0 中位", fr, fd, fd - fr))
    print("  %-12s %-14.0f %-14.0f  变化 %+.1f%%" % ("谱质心 Hz", cr, cd, 100 * (cd - cr) / cr))
    print("  %-12s %-14s %-14s" % ("峰值 dB", "%.2f" % db(np.max(np.abs(yr))), "%.2f" % db(np.max(np.abs(yo)))))
    print("\n  MFCC 距离（0=完全相同）: **%.2f**   %s" % (md,
          "✅ 音色确已改变" if md > 20 else "★ 太小，换声可能没生效"))
    print("  参考：本项目《八千里路》k=0 主线记的是 61.26；《我恨明月》记的是 32.42")


if __name__ == "__main__":
    main()
