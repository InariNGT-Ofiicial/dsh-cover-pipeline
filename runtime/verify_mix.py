# -*- coding: utf-8 -*-
"""verify_mix.py —— 混音/母带成品的客观验收工具

对一条成品 WAV 出「可判读」的指标表，并可（用 --ref）与参考版本逐项对比。
验收项：目标响度、真峰值上限、动态保留（波峰因数）、频谱分布、立体声相关度。

用法:
  python verify_mix.py 成品.wav
  python verify_mix.py 成品.wav --ref 旧版.wav --target-lufs -14 --json result.json
"""
from __future__ import annotations

import argparse
import json
import os

import numpy as np
import pyloudnorm as pyln
import soundfile as sf
from scipy.signal import welch

BANDS = [
    ("sub   20-60Hz", 20.0, 60.0),
    ("bass  60-250Hz", 60.0, 250.0),
    ("mid   250-2kHz", 250.0, 2000.0),
    ("hmid   2k-6kHz", 2000.0, 6000.0),
    ("high   6k-12kHz", 6000.0, 12000.0),
    ("air     12k+Hz", 12000.0, 20000.0),
]


def db(x) -> float:
    return float(20.0 * np.log10(max(float(x), 1e-12)))


def load(path: str):
    y, sr = sf.read(path, always_2d=True, dtype="float64")
    if y.shape[1] == 1:
        y = np.repeat(y, 2, axis=1)
    return y, sr


def true_peak_db(y: np.ndarray, oversample: int = 4, block: int = 2_000_000) -> float:
    """分块线性过采样，取真峰值近似（避免整段 4x 插值的内存峰值）。"""
    y = np.asarray(y, dtype=np.float64)
    if y.ndim == 1:
        y = y[:, None]
    n = len(y)
    mx = 0.0
    for s in range(0, n, block):
        e = min(n, s + block + 1)
        seg = y[s:e]
        m = len(seg)
        if m < 2:
            break
        idx = np.linspace(0.0, m - 1.0, m * oversample)
        base = np.arange(m)
        for c in range(seg.shape[1]):
            mx = max(mx, float(np.max(np.abs(np.interp(idx, base, seg[:, c])))))
    return round(db(mx), 2)


def band_energy(y: np.ndarray, sr: int):
    nper = 8192
    f, pxx = welch(y, fs=sr, nperseg=nper, noverlap=nper // 2, axis=0)
    p = pxx.mean(axis=1)
    total = float(p.sum()) + 1e-30
    bands = {name: round(100.0 * float(p[(f >= lo) & (f < hi)].sum()) / total, 2)
             for name, lo, hi in BANDS}
    return bands, f, p


def loudness_range(y: np.ndarray, sr: int, win_s: float = 3.0,
                   hop_s: float = 1.0):
    """EBU R128 式动态范围 LRA：短时(3s)响度的 10%~95% 分位差。"""
    mono = y.mean(axis=1) if y.ndim > 1 else y
    meter = pyln.Meter(sr)
    win, hop = int(win_s * sr), int(hop_s * sr)
    vals = []
    for s in range(0, max(1, len(mono) - win), hop):
        try:
            v = meter.integrated_loudness(mono[s:s + win])
        except Exception:  # noqa: BLE001
            continue
        if np.isfinite(v):
            vals.append(v)
    if len(vals) < 10:
        return None
    return round(float(np.percentile(vals, 95) - np.percentile(vals, 10)), 2)


def analyze(path: str) -> dict:
    y, sr = load(path)
    peak = float(np.max(np.abs(y)))
    rms = float(np.sqrt(np.mean(y ** 2) + 1e-12))
    lufs = float(pyln.Meter(sr).integrated_loudness(y))
    bands, f, p = band_energy(y, sr)
    centroid = round(float((f * p).sum() / (p.sum() + 1e-30)), 1)
    corr = None
    if y.shape[1] >= 2:
        corr = round(float(np.corrcoef(y[:, 0], y[:, 1])[0, 1]), 3)
    return {
        "path": os.path.basename(path),
        "seconds": round(len(y) / sr, 2),
        "lufs": round(lufs, 2),
        "lra": loudness_range(y, sr),
        "peak_db": round(db(peak), 2),
        "true_peak_db": true_peak_db(y),
        "rms_db": round(db(rms), 2),
        "crest_db": round(db(peak) - db(rms), 2),
        "bands_pct": bands,
        "centroid_hz": centroid,
        "stereo_corr": corr,
    }


def show(a: dict, ref: dict | None, target_lufs: float) -> list:
    checks = []
    print("=" * 66)
    print("成品: %s   (%.1f s)" % (a["path"], a["seconds"]))
    print("-" * 66)
    hdr = "%-14s %12s" % ("指标", "实测")
    if ref:
        hdr += " %12s %10s" % ("参考版", "差异")
    print(hdr)
    rows = [
        ("响度 LUFS", "lufs", "%.2f"),
        ("峰值 dBFS", "peak_db", "%.2f"),
        ("真峰值 dBTP", "true_peak_db", "%.2f"),
        ("RMS dBFS", "rms_db", "%.2f"),
        ("波峰因数 dB", "crest_db", "%.2f"),
        ("动态范围 LRA dB", "lra", "%.2f"),
        ("频谱质心 Hz", "centroid_hz", "%.1f"),
        ("立体声相关", "stereo_corr", "%.3f"),
    ]
    for label, key, fmt in rows:
        v = a.get(key)
        line = "%-14s %12s" % (label, "n/a" if v is None else fmt % v)
        if ref:
            rv = ref.get(key)
            line += " %12s" % ("n/a" if rv is None else fmt % rv)
            if v is not None and rv is not None:
                line += " %+10.2f" % (v - rv)
            else:
                line += " %10s" % "-"
        print(line)

    print("-" * 66)
    print("频段能量占比 (%)")
    print("  %-16s %10s" % ("频段", "实测") + (" %10s" % "参考版" if ref else ""))
    for name, _, _ in BANDS:
        line = "  %-16s %10.2f" % (name, a["bands_pct"][name])
        if ref:
            line += " %10.2f" % ref["bands_pct"][name]
        print(line)

    print("-" * 66)
    print("验收判定")
    items = [
        ("目标响度", "%.2f LUFS" % a["lufs"], "%.1f ±0.5" % target_lufs,
         abs(a["lufs"] - target_lufs) <= 0.5),
        ("真峰值上限", "%.2f dBTP" % a["true_peak_db"], "≤ -1.0",
         a["true_peak_db"] <= -1.0),
        ("动态保留(crest)", "%.2f dB" % a["crest_db"],
         ("≥ %.2f（参考）" % ref["crest_db"]) if ref else "≥ 12.0",
         (a["crest_db"] >= ref["crest_db"] - 0.2) if ref else (a["crest_db"] >= 12.0)),
    ]
    if a.get("lra") is not None:
        items.append((
            "动态范围(LRA)", "%.2f dB" % a["lra"],
            ("≥ %.2f（参考）" % ref["lra"]) if (ref and ref.get("lra")) else "报告项",
            (a["lra"] >= ref["lra"] - 0.2) if (ref and ref.get("lra")) else True))
    if a["stereo_corr"] is not None:
        items.append(("立体声宽度", "%.3f" % a["stereo_corr"], "0.20 ~ 0.95",
                      0.20 <= a["stereo_corr"] <= 0.95))
    for label, val, goal, ok in items:
        tag = "PASS" if ok else "WARN"
        print("  [%s] %-12s 实测 %-16s 目标 %s" % (tag, label, val, goal))
        checks.append({"item": label, "value": val, "goal": goal, "pass": bool(ok)})
    return checks


def main():
    ap = argparse.ArgumentParser(description="混音成品客观验收")
    ap.add_argument("target", help="待验收的 wav")
    ap.add_argument("--ref", default=None, help="参考版本 wav（通常是旧版）")
    ap.add_argument("--target-lufs", dest="target_lufs", type=float, default=-14.0)
    ap.add_argument("--json", dest="json_out", default=None)
    args = ap.parse_args()

    a = analyze(args.target)
    ref = analyze(args.ref) if args.ref else None
    checks = show(a, ref, args.target_lufs)

    if args.json_out:
        with open(args.json_out, "w", encoding="utf-8") as f:
            json.dump({"target": a, "reference": ref, "checks": checks,
                       "target_lufs": args.target_lufs}, f,
                      ensure_ascii=False, indent=2)
        print("\n[saved] %s" % args.json_out)


if __name__ == "__main__":
    main()
