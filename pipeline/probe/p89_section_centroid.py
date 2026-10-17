# -*- coding: utf-8 -*-
"""p89 逐段「像不像祥子」判据 —— 用谱质心，而不是靠耳朵猜。

依据（来自本项目 female/女声素材推理.md §6 的 kscan 实测标定）：
    输出 F0 213 → 质心 3090 ｜ 280 → 3490 ｜ 330 → 3610 ｜ 375 → 3660 ｜ 422 → 3710
    锚点：**祥子本人语音 3248** ｜《明月》已认可的成功输出 **3456**
    ⇒ 可用判据：**质心 ≥ 3550** 视为"祥子音色辨识成立"（下限约 300–350 Hz）

为什么需要它：换女声底模时，**低音区是否仍像祥子**是这套方案的核心风险，
而这件事有客观标定，不该靠感觉。

用法:
  python p89_section_centroid.py --dry 换声.wav --ref 源.wav \
     --win "hook:42.4:51.7" --win "主歌低:71.4:76.4" ...
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
CENTROID_OK = 3550.0          # 本项目标定：≥3550 视为祥子音色辨识成立
ANCHOR_SELF = 3248.0          # 祥子本人语音
ANCHOR_MINGYUE = 3456.0       # 《我恨明月不照我》已认可的成功输出


def rd(p):
    y, sr = sf.read(p, dtype="float32", always_2d=True)
    y = y.mean(axis=1).astype(np.float64)
    if sr != SR:
        y = librosa.resample(y, orig_sr=sr, target_sr=SR)
    return y


def stats(y, t0, t1):
    a, b = int(t0 * SR), int(t1 * SR)
    seg = y[a:b]
    if len(seg) < 4096:
        return None
    cen = float(np.mean(librosa.feature.spectral_centroid(y=seg, sr=SR)))
    f0, vf, _ = librosa.pyin(seg, fmin=65, fmax=1200, sr=SR,
                             frame_length=2048, hop_length=256)
    m = vf & np.isfinite(f0)
    f0m = float(np.median(f0[m])) if m.sum() > 10 else float("nan")
    return cen, f0m


def main():
    ap = argparse.ArgumentParser(description="逐段谱质心 / F0（判「像不像祥子」）")
    ap.add_argument("--dry", required=True)
    ap.add_argument("--ref", required=True)
    ap.add_argument("--win", action="append", required=True, metavar="NAME:T0:T1")
    args = ap.parse_args()

    yo, yr = rd(args.dry), rd(args.ref)
    wins = []
    for s in args.win:
        n, t0, t1 = s.rsplit(":", 2)
        wins.append((n, float(t0), float(t1)))

    print("=" * 92)
    print("逐段「像不像祥子」判据    判据: 质心 ≥ %.0f   （祥子语音 %.0f /《明月》成功输出 %.0f）"
          % (CENTROID_OK, ANCHOR_SELF, ANCHOR_MINGYUE))
    print("  %-14s %9s %9s %9s %9s %8s %s" %
          ("窗口", "源F0", "输出F0", "源质心", "输出质心", "质心差", "判定"))
    bad = 0
    for name, t0, t1 in wins:
        sd, rd_ = stats(yr, t0, t1), stats(yo, t0, t1)
        if sd is None or rd_ is None:
            print("  %-14s  (窗口超界或过短)" % name)
            continue
        cr, fr = sd
        cd, fd = rd_
        ok = cd >= CENTROID_OK
        if not ok:
            bad += 1
        print("  %-14s %9.1f %9.1f %9.0f %9.0f %+8.0f %s" %
              (name, fr, fd, cr, cd, cd - cr, "✅ 像" if ok else "★ 质心偏低"))
    print("\n  偏低窗口数: %d / %d" % (bad, len(wins)))
    if bad:
        print("  ⇒ 这些段落祥子音色辨识可能不成立；要么接受，要么只对这些段落做移调补偿")


if __name__ == "__main__":
    main()
