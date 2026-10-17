# -*- coding: utf-8 -*-
"""p91 候选源体检：批量量「干声音区」并给可否用的判定。

用途：给「换女声底模」挑源。硬门槛是**音区落在祥子可用窗口(≈300–550 Hz)**，
而这件事光看标题判不了 —— 必须分离出干声再量。

报告项（对齐本项目既有的 out_line.txt 口径）：
  P5 / P10 / P25 / P50 / P75 / P90 / P95  (pyin，fmin=65 fmax=1200)
  >=300Hz 占比（祥子识别下限）、>=400Hz 占比（旧口径）
判据：
  ★ P5 >= 300  → 全曲都在窗口内，**最优**（像 A）
  ⚠ P5 < 300 但 P25 >= 300 → 只有最低几句偏低，可能需局部补偿
  ✖ P50 < 300  → 主体在窗口外（像原曲/B），不建议

用法:
  python p91_source_survey.py 文件1.wav [文件2.wav ...]
"""
import os
import sys

import numpy as np
import soundfile as sf
import librosa

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

SR = 44100


def survey(p):
    y, sr = sf.read(p, dtype="float32", always_2d=True)
    y = y.mean(axis=1).astype(np.float64)
    if sr != SR:
        y = librosa.resample(y, orig_sr=sr, target_sr=SR)
    f0, vf, _ = librosa.pyin(y, fmin=65, fmax=1200, sr=SR,
                             frame_length=2048, hop_length=256)
    m = vf & np.isfinite(f0) & (f0 > 0)
    if m.sum() < 50:
        return None
    f = f0[m]
    q = {k: float(np.percentile(f, v)) for k, v in
         (("P5", 5), ("P10", 10), ("P25", 25), ("P50", 50), ("P75", 75), ("P90", 90), ("P95", 95))}
    return dict(dur=len(y) / SR, n=int(m.sum()), q=q,
                ge300=float(np.mean(f >= 300) * 100), ge400=float(np.mean(f >= 400) * 100))


def verdict(s):
    if s is None:
        return "浊音帧不足，无法评估"
    if s["q"]["P5"] >= 300:
        return "★ 最优：全曲都在窗口内（像 A）"
    if s["q"]["P25"] >= 300:
        return "⚠ 只有最低几句偏低，可能需局部补偿"
    if s["q"]["P50"] >= 300:
        return "⚠ 主体偏低，低段大概率不像祥子"
    return "✖ 主体在窗口外（像原曲/B），不建议"


print("%-34s %8s %7s %7s %7s %7s %7s %8s %9s %s" %
      ("文件", "时长s", "P5", "P25", "P50", "P75", "P95", ">=300%", ">=400%", "判定"))
print("-" * 132)
for p in sys.argv[1:]:
    if not os.path.exists(p):
        print("%-34s [缺] %s" % (os.path.basename(p)[:34], p))
        continue
    try:
        s = survey(p)
        if s is None:
            print("%-34s [浊音帧不足]" % os.path.basename(p)[:34])
            continue
        q = s["q"]
        print("%-34s %8.1f %7.1f %7.1f %7.1f %7.1f %7.1f %8.1f %9.1f %s" %
              (os.path.basename(p)[:34], s["dur"], q["P5"], q["P25"], q["P50"],
               q["P75"], q["P95"], s["ge300"], s["ge400"], verdict(s)))
    except Exception as e:  # noqa: BLE001
        print("%-34s ERR %s" % (os.path.basename(p)[:34], e))
print("\n参考：祥子可用窗口 ≈300–550 Hz ｜ A(梦的结唱halo) P5=327 ★ ｜ B(林沫沫) P5=167 ✖")
