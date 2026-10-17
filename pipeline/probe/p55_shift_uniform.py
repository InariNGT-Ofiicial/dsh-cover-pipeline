# -*- coding: utf-8 -*-
"""p55 整曲统一移调：伴奏与和声按同一个 K 平移（与人声同步 ⇒ 和声关系与比例都不变）。

为什么可以整曲一个 K：
  p54 实测原曲伴奏在副歌的 chroma 旋转 = +0 半音（相似度 0.999）⇒ 原曲**没有转调**，
  副歌只是音区抬高（八度级）。p53 实测原曲 副歌/主歌 比例 = 1.815（+10.32 半音）。
  ⇒ 只要整曲用同一个 K，这个比例就**精确保持**；分段（主歌+12/副歌+8）会把它压到 1.440（−21%）。

用法: python p55_shift_uniform.py 8
"""
import os
import sys
import numpy as np
import soundfile as sf
from pedalboard import Pedalboard, PitchShift

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

# 不带参数运行时的历史默认目录。随包分发后不再假设 D:/AI-Song：
# 用环境变量 COVER_PIPELINE_ROOT 指过去即可；插件调用时总是显式传 --inst-src/--harm-src。
W = os.environ.get("COVER_PIPELINE_ROOT", "")
INST_SRC = (W + "/01_sep/step1_kim/bqll/instrumental.wav") if W else None
HARM_SRC = (W + "/02_conv/in_harm/harm.wav") if W else None


def shift(y, sr, k):
    if abs(k) < 1e-9:
        return y.copy()
    b = Pedalboard([PitchShift(semitones=float(k))])
    x = np.ascontiguousarray(y.T.astype(np.float32))
    return np.asarray(b(x, sr), dtype=np.float32).T


# ★ 落盘格式默认 FLOAT（历史版写 PCM_24，是个缺陷）：
#   +8 移调后伴奏峰值可达 1.86 = +5.4 dBFS，写定点会被**硬削平** ——
#   实测 9245 个样本贴顶(≥0.9999)，且历史所有 +K 成品都带着这个削波。
#   写 FLOAT 保住真实波形，交给 mix_master 的 fix_inst_clip 做 tanh 软削(≤1.0，不硬切)。
SUBTYPE = "FLOAT"


def run(src, dst, k):
    y, sr = sf.read(src, dtype="float32", always_2d=True)
    dur = len(y) / sr
    print("  %-18s %.2fs  %dch" % (os.path.basename(src), dur, y.shape[1]), flush=True)
    o = shift(y, sr, k)
    n = min(len(o), len(y))
    sf.write(dst, o[:n], sr, subtype=SUBTYPE)
    print("    -> %s  k=%+g  %s  峰值 %.4f  RMS %+.2f dB"
          % (dst, k, SUBTYPE, float(np.max(np.abs(o[:n]))),
             20 * np.log10(np.sqrt(np.mean(o[:n].astype(np.float64) ** 2)) + 1e-12)), flush=True)


def main():
    import argparse
    ap = argparse.ArgumentParser(
        description="整曲统一移调：伴奏与和声按同一个 K 平移")
    ap.add_argument("k", nargs="?", type=float, default=8.0, help="半音数（默认 +8）")
    ap.add_argument("--outdir", default=None,
                    help="输出目录；不给则按历史行为写 _probe/gk<K>")
    ap.add_argument("--harm-src", default=None,
                    help="和声源；默认 in_harm/harm.wav（= 原曲和声，未换声）")
    ap.add_argument("--inst-src", default=None,
                    help="伴奏源；默认 01_sep/step1_kim/bqll/instrumental.wav"
                         "（★ 换歌必须显式指定，否则会拿 bqll 的伴奏去移调）")
    ap.add_argument("--subtype", default="FLOAT",
                    help="落盘格式；★ 默认 FLOAT（PCM_24 会硬削平超 0dBFS 的瞬态）")
    args = ap.parse_args()
    global SUBTYPE
    SUBTYPE = args.subtype
    k = args.k
    od = args.outdir or ((W + "/_probe/gk%d" % int(round(k))) if W else None)
    if not od:
        ap.error("缺少 --outdir（随包分发后不再有历史默认目录）")
    os.makedirs(od, exist_ok=True)
    harm_src = args.harm_src or HARM_SRC
    inst_src = args.inst_src or INST_SRC
    if not harm_src or not inst_src:
        ap.error("缺少 --inst-src / --harm-src（换歌必须显式指定伴奏与和声源）")
    print("[整曲统一移调] k=%+g  落盘=%s" % (k, SUBTYPE), flush=True)
    run(inst_src, od + "/inst.wav", k)
    run(harm_src, od + "/harm.wav", k)
    print("完成 -> %s" % od)


if __name__ == "__main__":
    main()
