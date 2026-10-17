# -*- coding: utf-8 -*-
"""p95 「清亮」客观画像 —— 多指标电池。

为什么这么写：
  "清亮"不该凭感觉定义。心理声学里有一个**标准化对应量**：**尖锐度 sharpness（acum）**
  （DIN 45692 / Fastl & Zwicker），本工具用开源实现 mosqito 计算它，
  再配一组标准 DSP 量做交叉验证 —— 单一指标不可信，这是本项目一贯的纪律。

指标分三层：
  【标准化】sharpness_din (acum)          <- 清亮度的正式对应量
            loudness_zwtv (sone)          <- 同步给出，用于确认响度已对齐
  【平衡类】mud 200-500Hz / presence 2-5k / air 6-12k 占比，以及 presence/mud 比
            spectral slope (dB/oct, 200Hz-8kHz)   <- 越平越亮
  【声源类】谱质心 & 质心/F0（★ 消掉 F0 的混淆）
            HNR、CPP（清晰度 vs 气声）
            LPC 共振峰 F1/F2/F3 与 F3-F1 间距（声道长度 => 少女感）

★ 关键纪律：所有文件先归一到**同一响度**再算 —— 否则测的是音量不是音色。
★ 分析窗自动挑"周期性最强"的一段，避免静音段把均值拉偏。

用法:
  python p95_brightness.py --file 名字=路径 [--file ...] [--win t0:t1] [--secs 12] [--lufs -20]
"""
from __future__ import annotations

import argparse
import os
import sys

import numpy as np
import soundfile as sf
import librosa
import pyloudnorm as pyln

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

# 音质库目录（mosqito 等，pip --target 装的独立目录）：
# 优先环境变量 COVER_QUALITY_LIB（插件会传），其次脚本旁的 _sq，再次历史路径。
SQ = (os.environ.get("COVER_QUALITY_LIB")
      or os.path.join(os.path.dirname(os.path.abspath(__file__)), "_sq"))
if not os.path.isdir(SQ) and os.path.isdir(r"D:/AI-Song/_pipeline_bqll/_probe/_sq"):
    SQ = r"D:/AI-Song/_pipeline_bqll/_probe/_sq"
if os.path.isdir(SQ):
    sys.path.insert(0, SQ)

SR = 44100
FS_PA = 1.0          # 约定：数字满刻度 1.0 == 1 Pa（94 dB SPL）。sharpness 已按总响度归一，
                     # 故该常数在**同响度对齐**的前提下不影响跨文件比较。

# numpy 2.0 把 trapz 改名 trapezoid；本机 env 版本不一，做兼容
_trapz = getattr(np, "trapezoid", None) or getattr(np, "trapz")


def load_mono(p):
    y, sr = sf.read(p, always_2d=True, dtype="float64")
    y = y.mean(axis=1)
    if sr != SR:
        from math import gcd
        from scipy.signal import resample_poly
        g = gcd(int(sr), SR)
        y = resample_poly(y, SR // g, int(sr) // g)
    return y


def pick_window(y, secs):
    """挑周期性最强的窗口。

    ★ 性能纪律：**不要**对每个候选窗做 `np.correlate(mode='full')` ——
    12 s×44.1k 是 O(n^2)≈1.7e10 次乘加，再乘几十个候选位，实际跑不完。
    这里改成：先降采样到 8 kHz，逐帧（40 ms / hop 20 ms）用 FFT 自相关取周期性峰，
    再对 (rms × 峰) 做**滑动平均**一次求出最佳窗 —— 整体 O(N log N)。
    """
    n = int(secs * SR)
    if len(y) <= n:
        return 0.0, len(y) / SR

    fs_s = 8000
    from math import gcd
    from scipy.signal import resample_poly
    g = gcd(SR, fs_s)
    ys = resample_poly(y, fs_s // g, SR // g)

    fl, hop = int(0.040 * fs_s), int(0.020 * fs_s)      # 40 ms / 20 ms
    nf = 1 + (len(ys) - fl) // hop
    if nf < 10:
        return 0.0, min(secs, len(y) / SR)
    idx = np.arange(fl)[None, :] + hop * np.arange(nf)[:, None]
    fr = ys[idx] * np.hanning(fl)[None, :]
    rms = np.sqrt(np.mean(fr ** 2, axis=1))

    nfft = 1 << int(np.ceil(np.log2(2 * fl)))
    S = np.fft.rfft(fr, n=nfft, axis=1)
    ac = np.fft.irfft(np.abs(S) ** 2, n=nfft, axis=1)[:, :fl]
    ac = ac / (ac[:, :1] + 1e-12)
    lo, hi = int(fs_s / 500), int(fs_s / 70)            # 70-500 Hz 的周期搜索范围
    peak = np.max(np.clip(ac[:, lo:hi], 0, 1), axis=1)

    score = rms * peak
    w = max(1, int(secs / 0.020))                        # 12 s 折算成帧数
    if w >= nf:
        best_i = int(np.argmax(np.cumsum(score)))
    else:
        cs = np.concatenate([[0.0], np.cumsum(score)])
        roll = (cs[w:] - cs[:-w]) / w
        best_i = int(np.argmax(roll)) + w // 2
    t0 = max(0.0, (best_i * hop) / fs_s - secs / 2.0)
    t0 = min(t0, (len(y) - n) / SR)
    return t0, t0 + secs


def sharpness(y):
    """DIN 45692 尖锐度（acum）+ Zwicker 响度（sone）。

    两个坑（已实测）：
      1. `sharpness_din_tv` 返回 **2** 个值 (sharpness, time)，不是 4 个 —— 按 4 个解包会抛异常。
      2. mosqito 的标准要求 fs >= 48 kHz，否则内部自行重采样并告警 —— 这里显式先重采样。
    """
    try:
        from math import gcd
        from scipy.signal import resample_poly
        from mosqito.sq_metrics import sharpness_din_tv, loudness_zwtv
        g = gcd(SR, 48000)
        y48 = resample_poly(y, 48000 // g, SR // g) * FS_PA
        s = np.asarray(sharpness_din_tv(y48, 48000, weighting="din", field_type="free")[0], dtype=float)
        n = np.asarray(loudness_zwtv(y48, 48000, field_type="free")[0], dtype=float)
        s = s[np.isfinite(s) & (s > 0)]
        n = n[np.isfinite(n) & (n > 0)]
        return (float(np.median(s)) if s.size else float("nan"),
                float(np.median(n)) if n.size else float("nan"))
    except Exception:  # noqa: BLE001
        return float("nan"), float("nan")


def bands(y):
    from scipy.signal import welch
    nper = 8192
    f, p = welch(y, fs=SR, nperseg=nper, noverlap=nper // 2)
    tot = _trapz(p, f) + 1e-20

    def r(a, b):
        m = (f >= a) & (f < b)
        return 100.0 * _trapz(p[m], f[m]) / tot

    mud, pres, air = r(200, 500), r(2000, 5000), r(6000, 12000)
    hf = r(4000, 16000)
    m = (f >= 200) & (f <= 8000) & (p > 0)
    sl = float(np.polyfit(np.log2(f[m]), 10 * np.log10(p[m]), 1)[0])
    cen = float(np.sum(f * p) / (np.sum(p) + 1e-20))
    return mud, pres, air, hf, sl, cen


def hnr_cpp(y):
    fl, hop = 2048, 512
    frames = librosa.util.frame(y, frame_length=fl, hop_length=hop).T
    win = np.hanning(fl)
    hnrs, cpps = [], []
    for fr in frames[::4]:
        fr = fr * win
        if np.sqrt(np.mean(fr ** 2)) < 1e-4:
            continue
        ac = np.correlate(fr, fr, mode="full")[fl - 1:]
        if ac[0] <= 0:
            continue
        ac = ac / ac[0]
        lo, hi = int(SR / 500), int(SR / 70)
        if hi <= lo:
            continue
        r = float(np.max(ac[lo:hi]))
        r = min(max(r, 1e-6), 0.999999)
        hnrs.append(10 * np.log10(r / (1 - r)))
        sp = np.abs(np.fft.rfft(fr, n=4096))
        cep = np.real(np.fft.irfft(np.log(sp + 1e-12)))
        qlo, qhi = int(4096 / 500), int(4096 / 70)
        seg = cep[qlo:qhi]
        if seg.size < 8:
            continue
        idx = np.arange(seg.size)
        lin = np.polyval(np.polyfit(idx, seg, 1), idx)
        cpps.append(20 * (float(np.max(seg - lin))))
    return (float(np.median(hnrs)) if hnrs else float("nan"),
            float(np.median(cpps)) if cpps else float("nan"))


def formants(y):
    """LPC 共振峰（前 3 个）的中位，返回 F1/F2/F3 与 F3-F1。"""
    fl, hop, order = 2048, 1024, 24
    frames = librosa.util.frame(y, frame_length=fl, hop_length=hop).T
    out = []
    for fr in frames[::3]:
        if np.sqrt(np.mean(fr ** 2)) < 1e-4:
            continue
        e = np.append(fr[0], fr[1:] - 0.97 * fr[:-1])
        e = e * np.hanning(len(e))
        try:
            a = librosa.lpc(e, order=order)
        except Exception:  # noqa: BLE001
            continue
        r = [z for z in np.roots(a) if np.imag(z) > 0.01]
        fs_ = sorted([np.arctan2(np.imag(z), np.real(z)) * SR / (2 * np.pi) for z in r])
        fs_ = [x for x in fs_ if 90 < x < 5500]
        if len(fs_) >= 3:
            out.append(fs_[:3])
    if len(out) < 5:
        return (float("nan"),) * 4
    a = np.median(np.array(out), axis=0)
    return float(a[0]), float(a[1]), float(a[2]), float(a[2] - a[0])


def f0_med(y):
    f0, vf, _ = librosa.pyin(y, fmin=65, fmax=1200, sr=SR,
                             frame_length=2048, hop_length=256)
    m = vf & np.isfinite(f0)
    return float(np.median(f0[m])) if m.sum() > 20 else float("nan")


def main():
    ap = argparse.ArgumentParser(description="「清亮」多指标画像")
    ap.add_argument("--file", action="append", required=True, metavar="NAME=PATH")
    ap.add_argument("--win", default=None, help="统一分析窗 t0:t1（不给则各自自动挑）")
    ap.add_argument("--secs", type=float, default=12.0)
    ap.add_argument("--lufs", type=float, default=-20.0, help="统一到该响度再测")
    args = ap.parse_args()

    items = []
    for s in args.file:
        n, p = s.split("=", 1)
        items.append((n, p))

    meter = pyln.Meter(SR)
    rows = []
    print("=" * 130)
    print("「清亮」多指标画像   （全部先归一到 %.0f LUFS 再测；sharpness = DIN 45692 acum）" % args.lufs)
    for name, path in items:
        if not os.path.exists(path):
            print("  [缺] %s = %s" % (name, path))
            continue
        y = load_mono(path)
        if args.win:
            t0, t1 = [float(x) for x in args.win.split(":")]
        else:
            t0, t1 = pick_window(y, args.secs)
        seg = y[int(t0 * SR):int(t1 * SR)]
        if seg.size < SR:
            print("  [过短] %s" % name)
            continue
        cur = float(meter.integrated_loudness(seg.astype(np.float64)))
        if not np.isfinite(cur):
            print("  [静] %s" % name)
            continue
        seg = seg * 10.0 ** ((args.lufs - cur) / 20.0)
        sh, sone = sharpness(seg)
        mud, pres, air, hf, sl, cen = bands(seg)
        hn, cp = hnr_cpp(seg)
        f1, f2, f3, disp = formants(seg)
        f0 = f0_med(seg)
        rows.append(dict(name=name, win="%.1f-%.1f" % (t0, t1), sh=sh, sone=sone,
                         mud=mud, pres=pres, air=air, hf=hf, sl=sl, cen=cen,
                         pm=pres / max(mud, 1e-9), cf=cen / max(f0, 1e-9),
                         hnr=hn, cpp=cp, f1=f1, f2=f2, f3=f3, disp=disp, f0=f0))
        print("  [done] %-32s 窗 %s" % (name, "%.1f-%.1f" % (t0, t1)))

    if not rows:
        return
    hdr = ("%-32s %7s %6s %6s %6s %6s %6s %7s %7s %7s %6s %6s %6s %6s"
           % ("名称", "sharp", "sone", "mud%", "pres%", "air%", ">4k%", "斜率", "质心",
              "质心/F0", "HNR", "CPP", "F1", "F3"))
    print("\n" + hdr)
    print("-" * len(hdr))
    for r in rows:
        print("%-32s %7.3f %6.1f %6.2f %6.2f %6.2f %6.2f %7.3f %7.0f %7.2f %6.1f %6.1f %6.0f %6.0f"
              % (r["name"], r["sh"], r["sone"], r["mud"], r["pres"], r["air"], r["hf"],
                 r["sl"], r["cen"], r["cf"], r["hnr"], r["cpp"], r["f1"], r["f3"]))
    print("\n  presence/mud 比（越大越亮、越小越闷） / F3-F1 间距 / F0:")
    for r in rows:
        print("    %-32s %6.2f    F3-F1 %6.0f Hz    F0 %6.1f Hz"
              % (r["name"], r["pm"], r["disp"], r["f0"]))


if __name__ == "__main__":
    main()
