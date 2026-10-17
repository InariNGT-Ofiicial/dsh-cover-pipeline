# -*- coding: utf-8 -*-
"""扫描人声层（k+8）在 128-152s 内所有「低塌高爆」事件（DDSP 破音同族），给出起止。"""
import os
import argparse
import numpy as np
import soundfile as sf
import librosa

# 默认值只为复现历史结果；插件调用时总是显式传 --lead/--ref。
# 随包分发后脚本目录不再等于历史 probe 目录，故用环境变量或脚本自身目录兜底。
P = os.environ.get("COVER_PROBE_DIR") or os.path.dirname(os.path.abspath(__file__))
W = os.environ.get("COVER_PIPELINE_ROOT", "")
SR16, HOP = 16000, 160
A, B = 126.0, 155.0
TH_LO, TH_HI = -5.0, 5.0

# ---- CLI（默认值 = 历史行为，保证旧结果仍可复现）----------------------------
_ap = argparse.ArgumentParser(description="扫描人声层「低塌高爆」破音同族事件")
_ap.add_argument("--lead", default=P + "/k4_8/lead_out/lead.wav",
                 help="待扫干声（默认 = 历史 k4_8）")
_ap.add_argument("--ref", default=(W + "/02_conv/in_lead/lead.wav") if W else "",
                 help="源人声对照（默认 = 原始干声 k0）")
_ap.add_argument("--a", type=float, default=A, help="扫描起始秒")
_ap.add_argument("--b", type=float, default=B, help="扫描结束秒")
_args = _ap.parse_args()
LEAD, REF = _args.lead, _args.ref
A, B = _args.a, _args.b
if not LEAD or not REF:
    _ap.error("缺少 --lead / --ref（随包分发后不再有历史默认干声）")


def band_feats(p):
    y, sr = sf.read(p, dtype="float32", always_2d=True)
    y = y.mean(axis=1).astype(np.float64)[int(A * sr):int(B * sr)]
    y16 = librosa.resample(np.ascontiguousarray(y), orig_sr=sr, target_sr=SR16)
    S = np.abs(librosa.stft(y16, n_fft=1024, hop_length=HOP))
    fr = librosa.fft_frequencies(sr=SR16, n_fft=1024)
    out = {}
    for nm, f0, f1 in [("lo", 300, 1000), ("hi", 6000, 8000), ("mid", 1000, 3000)]:
        mk = (fr >= f0) & (fr < f1)
        out[nm] = np.log10(S[mk].sum(axis=0) + 1e-12)
    rms = librosa.feature.rms(y=y16, frame_length=1024, hop_length=HOP)
    n = min(S.shape[1], rms.shape[1])
    return ({k: v[:n] for k, v in out.items()}, rms[0][:n],
            np.arange(n) * HOP / SR16 + A)


def zscore(x, half=50):
    n = len(x)
    z = np.zeros(n)
    for i in range(n):
        lo, hi = max(0, i - half), min(n, i + half + 1)
        med = np.median(x[lo:hi])
        mad = np.median(np.abs(x[lo:hi] - med)) + 1e-6
        z[i] = (x[i] - med) / (1.4826 * mad)
    return z


for tag, p in [("LEAD (%s)" % os.path.basename(os.path.dirname(LEAD)), LEAD),
               ("REF k0", REF)]:
    F, rms, ts = band_feats(p)
    zl, zh, zm = zscore(F["lo"]), zscore(F["hi"]), zscore(F["mid"])
    zr = zscore(rms)
    hit = (zl < TH_LO) & (zh > TH_HI)
    print("\n=== %s ===  命中帧 %d" % (tag, hit.sum()))
    runs = []
    i = 0
    n = len(hit)
    while i < n:
        if hit[i]:
            j = i
            while j < n and (hit[j] or (j + 1 < n and hit[j + 1])):
                j += 1
            runs.append((i, j - 1))
            i = j
        else:
            i += 1
    for a, b in runs:
        if (b - a) < 1:
            continue
        k = a + int(np.argmin(zl[a:b + 1]))
        print("   %7.3f-%.3f s (%.0f ms)  最差点 %.3f  lo %+.1f hi %+.1f mid %+.1f rms %+.1f"
              % (ts[a], ts[b], (b - a + 1) * 10, ts[k], zl[k], zh[k], zm[k], zr[k]))
