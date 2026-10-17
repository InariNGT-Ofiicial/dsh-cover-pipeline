# -*- coding: utf-8 -*-
"""mix_master.py —— 完整「混音 + 母带」链（pedalboard 驱动，纯 CLI）

相较旧版 `mix_tracks.py`（三轨相加 + 软限幅）的升级点：
  1. 用「线性整体增益」替代末端软限幅 —— 保平衡、不压扁动态
     （旧版软限幅阈值仅 -5.4 dBFS，把整首歌的正常峰值全压了一遍）
  2. 人声链：去浑浊 EQ → 提清晰 EQ → 自研 split-band 去齿音 → 压缩 → 混响
  3. 伴奏：次低频收紧 → 人声让位 EQ → 空气感
  4. 母带：glue 压缩 → BrickwallLimiter（真峰值）→ LUFS 归一化
  5. 全链路指标留痕，每一步都可回读（trace.json）

用法:
  python mix_master.py                          # 默认目标 -14 LUFS
  python mix_master.py --target -10             # 自定义响度目标
  python mix_master.py --out xxx.wav            # 指定输出
  python mix_master.py --no-reverb --no-deesser # 关闭模块
  python mix_master.py --set inst=path lead=path harm=path
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

import numpy as np
import pyloudnorm as pyln
import soundfile as sf
from scipy.ndimage import uniform_filter1d
from scipy.signal import butter, sosfiltfilt
from pedalboard import (
    BrickwallLimiter,
    Compressor,
    Gain,
    HighShelfFilter,
    HighpassFilter,
    LowShelfFilter,
    LowpassFilter,
    PeakFilter,
    Pedalboard,
    Reverb,
)

SR = 44100
BASE = r"D:\AI-Song\_pipeline_mingyue"

DEFAULT_INPUTS = {
    "inst": os.path.join(BASE, "01_sep", "step1_kim", "mingyue", "instrumental.wav"),
    "lead": os.path.join(BASE, "02_conv", "out_lead", "lead.wav"),
    "harm": os.path.join(BASE, "02_conv", "out_harm", "harm.wav"),
}
DEFAULT_OUT = os.path.join(BASE, "03_mix", "master", "shoko_mingyue_master.wav")

# ----------------------------------------------------------------------------
# 参数表（保守起步；每一组都能被 CLI 覆盖）
# ----------------------------------------------------------------------------
PARAMS = {
    # 人声 · 主唱
    "lead": {
        # ★ HPF 90 Hz（2026-10-11 二修）：原为 70 Hz。
        #   实测换声输出相对原曲在 0-30 s 段「凭空多出」40-80 Hz +5.1 dB / 80-120 Hz +1.6 dB
        #   （其余段落反而偏少），正是「前 30 秒低音段瑕疵」的物理本体。
        #   HPF 90 Hz 把这两段修到 +0.1 / -0.7 dB，而 120-250 Hz（人声基频）只多削约 1 dB。
        #   注：上一轮曾误判「HPF 90 Hz 反而恶化」——那是拿全带 flatness 评判所致，
        #   该指标对频谱倾斜敏感，与听感不对应；此处以「差异谱（换声/原曲）」为准。
        "hpf_hz": 90.0,             # 去低频嗡声/近讲效应 + 切除换声多余超低频
        "mud_hz": 280.0,            # 去浑浊
        "mud_db": -2.5,
        "mud_q": 1.0,
        "presence_hz": 3200.0,      # 提清晰度 / 唇齿
        "presence_db": 2.0,
        "presence_q": 0.9,
        # ★ 压缩工作点（2026-10-11 修正）：原 -18 dB / 3:1 过强 ——
        #   实测 0-30 s 频谱平坦度 0.01809（旧版 0.00599，+202%），是「低音段发浑/毛刺」
        #   的首要来源；前 30 s 是全场最安静的段落（RMS -16.9 dBFS），压缩器在那里
        #   工作最多，故瑕疵最集中（见 exp_shoko/probe_comp.py）。
        #   调到 -12 dB / 2:1 后 0-30 s flatness 降到 0.01014（+69%），
        #   且 LRA 首次达标（8.76 dB > 参考 8.13），波峰因数 15.49 仍远优于旧版 10.26。
        "comp_thr_db": -12.0,
        "comp_ratio": 2.0,
        "comp_attack_ms": 8.0,
        "comp_release_ms": 120.0,
        "comp_split_hz": 250.0,     # ★ 分频点：低于此频率不压缩（避免低音区互调失真）
        "gain_db": 0.0,
    },
    # 人声 · 和声（垫底、放远）
    "harm": {
        "gain_db": 0.0,             # 保持上游相对电平（忠实原曲声部平衡）
        "hpf_hz": 140.0,
        "lpf_hz": 9000.0,
    },
    # 去齿音（自研 split-band）
    "deesser": {
        "cutoff_hz": 5500.0,
        "threshold_db": -28.0,
        "ratio": 3.0,
        "smooth_ms": 4.0,
    },
    # 混响 send（空间统一 —— AI 翻唱「假」的头号解药）
    #   ★ 并联模式：湿信号先做 RMS 归一化，再按 wet_mix 叠加。
    #     pedalboard 的 Reverb 不守恒电平（内部 comb 反馈实测 +6 dB），
    #     直接串联 wet_level 会瞬间破坏人声/伴奏平衡。
    "reverb": {
        "room_size": 0.32,
        "damping": 0.55,
        "wet_mix": 0.28,
        "width": 1.0,
    },
    # 伴奏
    "inst": {
        "hpf_hz": 35.0,
        "carve_hz": 3000.0,         # 给人声让位
        "carve_db": -1.5,
        "carve_q": 1.4,
        "air_hz": 10000.0,
        "air_db": 0.8,
        "air_q": 1.0,
    },
    # 母带
    "master": {
        "lowshelf_hz": 90.0,        # 去浑浊
        "lowshelf_db": -1.0,
        "lowshelf_q": 0.7,
        "glue_thr_db": -12.0,
        "glue_ratio": 1.3,
        "glue_attack_ms": 30.0,
        "glue_release_ms": 600.0,
        "ceiling_db": -1.0,         # 真峰值上限
        "limiter_release_ms": 100.0,
        "lookahead_ms": 2.0,
    },
    # 电平策略
    "gain_staging": {
        "pre_peak_target_db": -3.0,  # 相加后整体线性归一到 -3 dBFS
        "fix_inst_clip": True,       # 软削修复伴奏内部过载（>1.0 的样本）
    },
    "target_lufs": -14.0,
}

# ----------------------------------------------------------------------------
# profile —— 把「低频保护」做成可切换档位
#
# 背景（实测，见 exp_shoko/diag_lowfreq.py 与 probe_fix.py）：
#   换声输出在低音区自带宽频成分：0-30s 频谱平坦度 0.0157，是原唱 0.0034 的 4.6 倍。
#   且下列手段全部无法把它分离掉——
#     时域软门限   0.01573 -> 0.01570（无效）
#     谱减 6/10 dB 0.01573 -> 0.01573（完全无变化）
#     频域下行扩展 仅 -2.4%
#     高通 90 Hz   反而升到 0.01635（并削掉低音区基频 1.7%）
#   ⇒ 它不是「可去除的噪声」，而是换声模型的合成特性（结构性）。
#
# 因此混音侧唯一可控的是「露出多少」：回调低频削减以恢复掩蔽，同时保留高频提亮。
# ----------------------------------------------------------------------------
PROFILES = {
    "standard": {},                    # 清晰度优先（当前默认）
    "lowband-safe": {                  # 低音段保护档 —— 换声素材推荐
        "master.lowshelf_db": -0.2,    # -1.0 -> -0.2  少削低频，恢复掩蔽
        "inst.hpf_hz": 28.0,           # 35   -> 28     保住 sub
        "lead.mud_db": -1.5,           # -2.5 -> -1.5   少挖低音区
        "lead.presence_db": 1.6,       # 2.0  -> 1.6    略收提亮，减少宽频成分暴露
    },
}


def apply_profile(name: str) -> None:
    """把 profile 的覆盖项就地写进 PARAMS。"""
    if name not in PROFILES:
        raise SystemExit("未知 profile: %s（可选: %s）" % (name, ", ".join(PROFILES)))
    for dotted, val in PROFILES[name].items():
        sec, key = dotted.split(".", 1)
        PARAMS[sec][key] = val
    PARAMS["profile"] = name


# ----------------------------------------------------------------------------
# 基础工具
# ----------------------------------------------------------------------------
def db(x) -> float:
    return float(20.0 * np.log10(max(float(x), 1e-12)))


def metrics(y: np.ndarray, sr: int = SR) -> dict:
    """峰值 / RMS / LUFS / 波峰因数 / 真峰值（4x 线性过采样近似）"""
    y = np.asarray(y, dtype=np.float64)
    peak = float(np.max(np.abs(y))) if y.size else 0.0
    rms = float(np.sqrt(np.mean(y ** 2) + 1e-12))
    try:
        lufs = round(float(pyln.Meter(sr).integrated_loudness(y)), 2)
    except Exception:  # noqa: BLE001
        lufs = float("nan")
    return {
        "peak_db": round(db(peak), 2),
        "rms_db": round(db(rms), 2),
        "lufs": lufs,
        "crest_db": round(db(peak) - db(rms), 2),
    }


def true_peak_db(y: np.ndarray, sr: int = SR, oversample: int = 4) -> float:
    """真峰值近似：线性过采样后取最大绝对值（BS.1770 附录 2 的精简实现）。
    只在关键节点调用（较慢），日常 metrics() 不含此项。"""
    y = np.asarray(y, dtype=np.float64)
    if y.ndim == 1:
        y = y[:, None]
    n = len(y)
    idx = np.linspace(0.0, n - 1.0, n * oversample)
    base = np.arange(n)
    tp = max(float(np.max(np.abs(np.interp(idx, base, y[:, c]))))
             for c in range(y.shape[1]))
    return round(db(tp), 2)


def load_audio(path: str, force_stereo: bool = True) -> np.ndarray:
    y, sr = sf.read(path, always_2d=True, dtype="float32")
    if sr != SR:
        raise ValueError("采样率不符: %s (%d Hz，需 %d)" % (path, sr, SR))
    if y.shape[1] == 1 and force_stereo:
        y = np.repeat(y, 2, axis=1)
    elif y.shape[1] > 2:
        y = y[:, :2]
    return np.ascontiguousarray(y, dtype=np.float32)


def soft_clip_fix(y: np.ndarray, ceiling: float = 1.0, knee: float = 0.7) -> np.ndarray:
    """把超过 knee 的样本用 tanh 软削，渐近到 ceiling（严格不超），不产生新的硬削波。"""
    a = np.abs(y)
    over = a > knee
    if not np.any(over):
        return y
    out = y.copy()
    span = ceiling - knee
    e = a[over] - knee
    out[over] = np.sign(y[over]) * (knee + span * np.tanh(e / span))
    return np.clip(out, -ceiling, ceiling)


def process(board: Pedalboard, y: np.ndarray, sr: int = SR) -> np.ndarray:
    return np.asarray(board(y, sr), dtype=np.float32)


def splitband_compress(y: np.ndarray, sr: int = SR, fc_hz: float = 250.0,
                       order: int = 4, **cps) -> np.ndarray:
    """分频段压缩：低带（<fc）原样通过，只压高带（完美重构）。

    ★ 为什么必须这样做：
      pedalboard 的 Compressor 没有侧链输入（构造参数只有 threshold_db / ratio /
      attack_ms / release_ms 四项）。把整带信号直接送进去时，低音区基频
      （120-250 Hz，周期 4-8 ms）会与 8 ms attack / 120 ms release 发生「部分响应」，
      形成周期性增益调制 ⇒ 互调失真。
      实测（换声人声 0-30 s）：频谱平坦度 0.0157 → 0.0225（+43%）；
      release 加到 400 ms 更糟（+60%）。这正是听感上「低音段发浑/毛刺」的来源。
      分频后高带最低频率 = fc（250 Hz，周期 4 ms），压缩器可平滑跟随，失真消失：
      实测分频版 flatness 0.01577，与「完全不加压缩」的 0.01573 持平。
    """
    sos = butter(order, fc_hz / (sr / 2.0), btype="low", output="sos")
    low = sosfiltfilt(sos, y, axis=0).astype(np.float32)
    high = (y - low).astype(np.float32)
    hi_c = process(Pedalboard([Compressor(**cps)]), high)
    return (low + hi_c).astype(np.float32)


# ----------------------------------------------------------------------------
# 自研 split-band 去齿音
#   pedalboard 没有 Deesser（0.9.26 也没有此插件），这里自己组合实现：
#   低带 = 4 阶 Butterworth 低通（sosfiltfilt 零相位）
#   高带 = 原信号 - 低带      ← 严格完美重构（low+high 恒等于原信号），不染色
#   只对高带做包络跟随压缩 —— 齿音过强时才衰减。
# ----------------------------------------------------------------------------
def deesser(y: np.ndarray, sr: int = SR, cutoff_hz: float = 5500.0,
            threshold_db: float = -28.0, ratio: float = 3.0,
            smooth_ms: float = 4.0) -> np.ndarray:
    y = np.asarray(y, dtype=np.float32)
    if y.ndim == 1:
        y = y[:, None]
    sos_lp = butter(4, cutoff_hz / (sr / 2.0), btype="low", output="sos")
    w = max(1, int(round(smooth_ms / 1000.0 * sr)))
    out = np.empty_like(y)
    for c in range(y.shape[1]):
        mono = y[:, c].astype(np.float64)
        low = sosfiltfilt(sos_lp, mono)
        high = mono - low                            # 完美重构
        env = uniform_filter1d(np.abs(high), size=w, mode="nearest")
        env_db = 20.0 * np.log10(env + 1e-12)
        over = np.maximum(env_db - threshold_db, 0.0)
        g_db = -over * (1.0 - 1.0 / ratio)
        g = 10.0 ** (g_db / 20.0)
        out[:, c] = (low + high * g).astype(np.float32)
    return out


# ----------------------------------------------------------------------------
# 链路各段
# ----------------------------------------------------------------------------
def vocal_lead_chain(y: np.ndarray, p: dict, use_deesser: bool) -> tuple:
    """主唱链，返回 (输出, makeup_db)。

    ★ 压缩器不会自动补偿增益（无 auto-makeup）。若不补，主唱会被整体压轻、
      在混音里被伴奏埋掉 —— 实测不补时主唱掉 5.5 LU。这里按压缩前后的 RMS
      差自动补回，压缩器因此只负责「控动态」，不负责「改电平」。
    ★ 压缩改为「分频段」执行：低音区（<comp_split_hz）不过压缩器。
      这是修正「低音段发浑/毛刺」的关键 —— 见 splitband_compress 的说明。
    """
    board = Pedalboard([
        HighpassFilter(cutoff_frequency_hz=p["hpf_hz"]),
        PeakFilter(cutoff_frequency_hz=p["mud_hz"], gain_db=p["mud_db"], q=p["mud_q"]),
        PeakFilter(cutoff_frequency_hz=p["presence_hz"], gain_db=p["presence_db"],
                   q=p["presence_q"]),
    ])
    out = process(board, y)
    out = splitband_compress(
        out, fc_hz=p.get("comp_split_hz", 250.0),
        threshold_db=p["comp_thr_db"], ratio=p["comp_ratio"],
        attack_ms=p["comp_attack_ms"], release_ms=p["comp_release_ms"],
    )
    if use_deesser:
        d = PARAMS["deesser"]
        out = deesser(out, cutoff_hz=d["cutoff_hz"], threshold_db=d["threshold_db"],
                      ratio=d["ratio"], smooth_ms=d["smooth_ms"])
    r_in = float(np.sqrt(np.mean(np.asarray(y, dtype=np.float64) ** 2) + 1e-12))
    r_out = float(np.sqrt(np.mean(np.asarray(out, dtype=np.float64) ** 2) + 1e-12))
    makeup_db = db(r_in) - db(r_out)
    out = out * (10.0 ** ((makeup_db + p["gain_db"]) / 20.0))
    return np.ascontiguousarray(out, dtype=np.float32), round(makeup_db, 2)


def vocal_harm_chain(y: np.ndarray, p: dict) -> np.ndarray:
    board = Pedalboard([
        Gain(gain_db=p["gain_db"]),
        HighpassFilter(cutoff_frequency_hz=p["hpf_hz"]),
        LowpassFilter(cutoff_frequency_hz=p["lpf_hz"]),
    ])
    return process(board, y)


def vocal_reverb(y: np.ndarray, p: dict) -> np.ndarray:
    """并联混响 send。

    ★ pedalboard 的 Reverb 不守恒电平（comb 反馈会把湿尾放大，实测整体 +6.2 dB）。
      正确做法：取 100% 湿信号 → RMS 归一化到干声量级 → 按 wet_mix 叠加。
      这样混响只贡献「空间感」，不改变人声与伴奏的平衡。
    """
    board = Pedalboard([
        Reverb(room_size=p["room_size"], damping=p["damping"],
               wet_level=1.0, dry_level=0.0, width=p["width"]),
    ])
    wet = process(board, y)
    r_in = float(np.sqrt(np.mean(np.asarray(y, dtype=np.float64) ** 2) + 1e-12))
    r_wet = float(np.sqrt(np.mean(np.asarray(wet, dtype=np.float64) ** 2) + 1e-12))
    if r_wet > 1e-9:
        wet = wet * (r_in / r_wet)
    out = y + wet * p["wet_mix"]
    return np.ascontiguousarray(out, dtype=np.float32)


def inst_chain(y: np.ndarray, p: dict) -> np.ndarray:
    board = Pedalboard([
        HighpassFilter(cutoff_frequency_hz=p["hpf_hz"]),
        PeakFilter(cutoff_frequency_hz=p["carve_hz"], gain_db=p["carve_db"],
                   q=p["carve_q"]),
        HighShelfFilter(cutoff_frequency_hz=p["air_hz"], gain_db=p["air_db"],
                        q=p["air_q"]),
    ])
    return process(board, y)


def master_chain(y: np.ndarray, p: dict) -> tuple[np.ndarray, dict]:
    board = Pedalboard([
        LowShelfFilter(cutoff_frequency_hz=p["lowshelf_hz"], gain_db=p["lowshelf_db"],
                       q=p["lowshelf_q"]),
        Compressor(threshold_db=p["glue_thr_db"], ratio=p["glue_ratio"],
                   attack_ms=p["glue_attack_ms"], release_ms=p["glue_release_ms"]),
    ])
    out = process(board, y)
    limiter = Pedalboard([
        BrickwallLimiter(ceiling_db=p["ceiling_db"], release_ms=p["limiter_release_ms"],
                         lookahead_ms=p["lookahead_ms"], true_peak=True),
    ])
    return out, {"limiter": limiter}


def normalize_to_lufs(y: np.ndarray, sr: int, target_lufs: float,
                      limiter: Pedalboard, max_iter: int = 4) -> tuple[np.ndarray, dict]:
    """迭代：增益 → 限幅 → 复测，收敛到目标 LUFS（±0.05 LU）。"""
    meter = pyln.Meter(sr)
    y = np.asarray(y, dtype=np.float32)
    hist = []
    cur = y
    for i in range(max_iter):
        lufs = float(meter.integrated_loudness(cur.astype(np.float64)))
        delta = target_lufs - lufs
        hist.append({"iter": i, "lufs_in": round(lufs, 2), "delta_db": round(delta, 3)})
        if abs(delta) < 0.05:
            break
        cur = (cur * (10.0 ** (delta / 20.0))).astype(np.float32)
        cur = np.asarray(limiter(cur, sr), dtype=np.float32)
    hist.append({"iter": "final", "lufs": round(
        float(meter.integrated_loudness(cur.astype(np.float64))), 2)})
    return cur, {"iterations": hist}


# ----------------------------------------------------------------------------
def run(args) -> dict:
    t0 = time.time()
    apply_profile(getattr(args, "profile", "standard"))
    for kv in (getattr(args, "p", None) or []):
        dotted, val = kv.split("=", 1)
        sec, key = dotted.split(".", 1)
        cur = PARAMS[sec][key]
        PARAMS[sec][key] = type(cur)(float(val)) if isinstance(cur, (int, float)) else val
    trace: dict = {"params": PARAMS, "profile": PARAMS.get("profile", "standard"),
                   "target_lufs": args.target_lufs, "inputs": {}, "stages": []}

    # ---- STAGE 0/1: 读入 + 诊断 ----
    src = dict(DEFAULT_INPUTS)
    for kv in (args.set or []):
        key, val = kv.split("=", 1)
        src[key] = val
    y = {}
    print("=" * 68)
    print("[1] 素材诊断")
    for k in ("inst", "lead", "harm"):
        y[k] = load_audio(src[k], force_stereo=(k != "inst"))
        m = metrics(y[k])
        trace["inputs"][k] = {"path": src[k], **m}
        print("    %-5s %s" % (k, json.dumps(m, ensure_ascii=False)))

    n = min(len(y[k]) for k in y)
    for k in y:
        y[k] = y[k][:n]
    print("    对齐长度: %.2f s" % (n / SR))

    # ---- STAGE 2: 伴奏过载修复（可选） ----
    if PARAMS["gain_staging"]["fix_inst_clip"]:
        before = float(np.mean(np.abs(y["inst"]) > 1.0)) * 100
        y["inst"] = soft_clip_fix(y["inst"], 1.0)
        after = float(np.mean(np.abs(y["inst"]) > 1.0)) * 100
        trace["stages"].append({"stage": "fix_inst_clip",
                                "over_pct_before": round(before, 5),
                                "over_pct_after": round(after, 5),
                                "peak_db_after": metrics(y["inst"])["peak_db"]})
        print("    [修复] 伴奏过载样本 %.5f%% -> %.5f%%" % (before, after))

    # ---- STAGE 3: 人声处理 ----
    print("[2] 人声链")
    lead, makeup_db = vocal_lead_chain(y["lead"], PARAMS["lead"], not args.no_deesser)
    print("    lead 处理后 %s（自动 makeup %+.2f dB）"
          % (json.dumps(metrics(lead), ensure_ascii=False), makeup_db))
    harm = vocal_harm_chain(y["harm"], PARAMS["harm"])
    print("    harm 处理后 %s" % json.dumps(metrics(harm), ensure_ascii=False))
    vocal = lead + harm
    m_vocal_pre = metrics(vocal)
    if not args.no_reverb:
        vocal = vocal_reverb(vocal, PARAMS["reverb"])
    m_vocal = metrics(vocal)
    trace["stages"].append({"stage": "vocal_bus", "pre_reverb": m_vocal_pre,
                            "post": m_vocal,
                            "reverb": None if args.no_reverb else PARAMS["reverb"]})
    print("    人声总线 %s%s" % (json.dumps(m_vocal, ensure_ascii=False),
                                "" if args.no_reverb else "（含混响）"))

    # ---- STAGE 4: 伴奏处理 ----
    print("[3] 伴奏链")
    inst = inst_chain(y["inst"], PARAMS["inst"])
    trace["stages"].append({"stage": "inst", "pre": metrics(y["inst"]),
                            "post": metrics(inst)})
    print("    inst 处理后 %s" % json.dumps(metrics(inst), ensure_ascii=False))

    # ---- STAGE 5: 母线 + 线性整体增益（保平衡） ----
    print("[4] 母线")
    mix = inst + vocal
    m_sum = metrics(mix)
    print("    相加后 %s" % json.dumps(m_sum, ensure_ascii=False))
    g = PARAMS["gain_staging"]["pre_peak_target_db"] - m_sum["peak_db"]
    mix = (mix * (10.0 ** (g / 20.0))).astype(np.float32)
    m_gs = metrics(mix)
    trace["stages"].append({"stage": "sum_and_gain_staging",
                            "sum": m_sum, "linear_gain_db": round(g, 2),
                            "post": m_gs})
    print("    线性整体增益 %+.2f dB -> %s" % (g, json.dumps(m_gs, ensure_ascii=False)))

    # ---- STAGE 6: 母带 ----
    print("[5] 母带链")
    mixed, ctx = master_chain(mix, PARAMS["master"])
    m_master = metrics(mixed)
    print("    EQ+glue压缩后 %s" % json.dumps(m_master, ensure_ascii=False))
    out, norm = normalize_to_lufs(mixed, SR, args.target_lufs, ctx["limiter"])
    m_final = metrics(out)
    trace["stages"].append({"stage": "master", "post_eq_comp": m_master,
                            "normalize": norm, "final": m_final})
    print("    LUFS 归一化(-%s) %s" % (abs(args.target_lufs),
                                      json.dumps(m_final, ensure_ascii=False)))
    for h in norm["iterations"]:
        print("      %s" % json.dumps(h, ensure_ascii=False))

    # ---- STAGE 7: 输出 ----
    out_path = args.out or DEFAULT_OUT
    if args.target_lufs != -14.0:
        root, ext = os.path.splitext(out_path)
        out_path = "%s_%dLUFS%s" % (root, int(abs(args.target_lufs)), ext)
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    sf.write(out_path, out, SR, subtype="PCM_24")
    trace["output"] = {"path": out_path, "subtype": "PCM_24", **m_final}
    print("[6] 输出 %s  (%.1f s 音频, 耗时 %.1f s)" % (
        out_path, len(out) / SR, time.time() - t0))

    trace_path = os.path.join(os.path.dirname(out_path), "mix_trace.json")
    with open(trace_path, "w", encoding="utf-8") as f:
        json.dump(trace, f, ensure_ascii=False, indent=2)
    print("    链路留痕: %s" % trace_path)
    return trace


def main():
    ap = argparse.ArgumentParser(description="完整混音+母带链")
    ap.add_argument("--target", dest="target_lufs", type=float,
                    default=PARAMS["target_lufs"], help="目标 LUFS（默认 -14）")
    ap.add_argument("--out", default=None, help="输出 wav 路径")
    ap.add_argument("--no-reverb", action="store_true", help="关闭人声混响")
    ap.add_argument("--no-deesser", action="store_true", help="关闭去齿音")
    ap.add_argument("--profile", default="standard", choices=list(PROFILES),
                    help="参数档位（lowband-safe = 低音段保护，换声素材推荐）")
    ap.add_argument("--p", action="append", metavar="SEC.KEY=VALUE",
                    help="覆盖任意参数，如 --p master.lowshelf_db=0（可重复）")
    ap.add_argument("--set", action="append", metavar="KEY=PATH",
                    help="覆盖输入轨路径，如 inst=D:\\x.wav")
    args = ap.parse_args()
    run(args)


if __name__ == "__main__":
    main()
