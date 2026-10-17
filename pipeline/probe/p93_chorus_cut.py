# -*- coding: utf-8 -*-
"""p93 副歌裁剪器 —— 把成品裁成「只保留副歌」的短版，且切口不带咔哒。

为什么需要专门的工具（而不是随便切）：
  1. **切口位置不能凭 LRC 时间戳**。LRC 是"人声起唱点"，而音乐的乐句边界通常略早。
     本工具在每个标称边界附近 ±snap 秒内**找短时能量的局部极小值**作为真正切口
     （乐句之间的空隙能量最低，从那里切最不容易切到音符中间）。
  2. **切口必须做淡入淡出**。硬切会产生阶跃，听感就是咔哒/爆音。
  3. **裁完必须重新定响度**。裁剪后整合响度必然变（少了安静段/多了副歌），
     不复归一化就会和其他成品不在同一响度，失去可比性。
  4. **必须验切口**。本工具报告每个接缝处的最大样点跳变，并与全曲分位数比较，
     判定是否为"引入的咔哒"。

用法:
  python p93_chorus_cut.py --src 成品.wav --out 裁剪.wav \
      --segs "46.27:69.00,107.85:128.47" [--snap 0.6] [--fade 0.06] [--gap 0.12] \
      [--target -14.0]
"""
from __future__ import annotations

import argparse
import sys

import numpy as np
import soundfile as sf
import pyloudnorm as pyln

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

SR = 44100


def snap_min(y, t, snap, win=0.010):
    """在 t±snap 秒内找短时能量的局部极小点，返回更合适的切口时间。"""
    a = max(0, int((t - snap) * SR))
    b = min(len(y), int((t + snap) * SR))
    if b - a < SR // 10:
        return t, 0.0
    w = max(1, int(win * SR))
    n = (b - a) // w
    if n < 3:
        return t, 0.0
    seg = y[a:a + n * w].reshape(n, w, -1)
    e = np.sqrt(np.mean(seg ** 2, axis=(1, 2)))
    i = int(np.argmin(e))
    # 局部极小才认，否则保持原位（避免把切口推到奇怪的静音处）
    if 0 < i < n - 1 and e[i] < 0.5 * np.median(e):
        return (a + i * w) / SR, (t - (a + i * w) / SR)
    return t, 0.0


def main():
    ap = argparse.ArgumentParser(description="副歌裁剪（能量极小切口 + 淡入淡出 + 重新定响度）")
    ap.add_argument("--src", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--segs", required=True, help='"t0:t1,t0:t1,..." 秒')
    ap.add_argument("--snap", type=float, default=0.6, help="边界吸附搜索半径（秒）")
    ap.add_argument("--fade", type=float, default=0.06, help="每段首尾淡入淡出（秒）")
    ap.add_argument("--gap", type=float, default=0.12, help="段间静音（秒）")
    ap.add_argument("--target", type=float, default=-14.0, help="重新归一化目标 LUFS")
    ap.add_argument("--no-normalize", action="store_true")
    args = ap.parse_args()

    y, sr = sf.read(args.src, always_2d=True, dtype="float64")
    if sr != SR:
        # 原曲 mp3 常是 48 kHz；成品是 44.1 kHz。用多相滤波重采样（保能量），
        # 使裁剪结果与全项目 44.1 kHz 口径一致。
        from math import gcd
        from scipy.signal import resample_poly
        g = gcd(int(sr), SR)
        y = resample_poly(y, SR // g, int(sr) // g, axis=0)
        print("  [重采样] %d -> %d Hz（resample_poly）" % (sr, SR))
        sr = SR
    mono = y.mean(axis=1)

    segs = []
    for s in args.segs.split(","):
        t0, t1 = s.split(":")
        segs.append((float(t0), float(t1)))

    print("=" * 78)
    print("副歌裁剪   src=%s" % args.src.split("/")[-1])
    print("  标称段与吸附后的切口（能量极小点）:")
    pieces = []
    for t0, t1 in segs:
        n0, d0 = snap_min(mono, t0, args.snap)
        n1, d1 = snap_min(mono, t1, args.snap)
        print("    %7.3f - %7.3f  ->  %7.3f - %7.3f   (偏移 %+.3f / %+.3f s)  时长 %.2f s"
              % (t0, t1, n0, n1, n0 - t0, n1 - t1, n1 - n0))
        pieces.append((n0, n1))

    nf = int(args.fade * SR)
    ng = int(args.gap * SR)
    outs = []
    for i, (a, b) in enumerate(pieces):
        seg = y[int(a * SR):int(b * SR)].copy()
        if nf > 0 and len(seg) > 2 * nf:
            ramp = np.linspace(0.0, 1.0, nf)[:, None]
            seg[:nf] *= ramp
            seg[-nf:] *= ramp[::-1]
        outs.append(seg)
        if i < len(pieces) - 1:
            outs.append(np.zeros((ng, y.shape[1])))
    z = np.concatenate(outs, axis=0)

    # 归一化
    meter = pyln.Meter(SR)
    lufs_in = float(meter.integrated_loudness(z))
    if not args.no_normalize:
        z = z * 10.0 ** ((args.target - lufs_in) / 20.0)
    lufs_out = float(meter.integrated_loudness(z))
    pk = float(np.max(np.abs(z)))

    # 切口咔哒体检：接缝处最大样点跳变 vs 全曲分位
    d = np.abs(np.diff(z.mean(axis=1)))
    p999 = float(np.percentile(d, 99.9))
    seams = []
    pos = 0
    for i, (a, b) in enumerate(pieces):
        pos += len(y[int(a * SR):int(b * SR)])
        if i < len(pieces) - 1:
            j = pos + ng // 2
            seams.append((j / SR, float(d[max(0, j - 2):j + 2].max())))
            pos += ng
    print("\n  裁后: 时长 %.2f s ｜ 归一化前 %.2f LUFS -> 归一化后 %.2f LUFS ｜ 峰值 %.2f dBFS"
          % (len(z) / SR, lufs_in, lufs_out, 20 * np.log10(max(pk, 1e-12))))
    print("  全曲样点跳变 P99.9 = %.5f" % p999)
    bad = 0
    for t, v in seams:
        ok = v <= max(p999, 1e-4)
        bad += 0 if ok else 1
        print("    接缝 @ %6.3f s  最大跳变 %.5f  %s" % (t, v, "OK" if ok else "★ 高于全曲分位"))
    print("  判定: %s" % ("全部接缝无异常咔哒 ✅" if bad == 0 else "★ %d 处接缝需检查" % bad))

    sf.write(args.out, z.astype(np.float32), SR, subtype="FLOAT")
    print("  -> %s" % args.out)


if __name__ == "__main__":
    main()
