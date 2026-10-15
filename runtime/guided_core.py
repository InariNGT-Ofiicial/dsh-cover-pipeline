# Experimental guided renderer derived from p51; no song-specific pilot or main.
# -*- coding: utf-8 -*-
"""Experimental voicing-guided DDSP/NSF renderer.
This optional backend has not received baseline integration/listening validation.
Voicing gates and smoothing are heuristic; no universal quality claim is made.
"""
import os
import sys
import argparse
import numpy as np
import soundfile as sf
import torch
import torch.nn.functional as F

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

# ------------------------------------------------------------------ 工具
def limit_runs(flag, max_frames):
    """把连续长度超过 max_frames 的 run 置 0（防长段误判）。"""
    flag = np.asarray(flag).astype(bool)
    if max_frames <= 0:
        return flag.astype(np.float64)
    out = np.zeros(len(flag), dtype=np.float64)
    i, n = 0, len(flag)
    while i < n:
        if flag[i]:
            j = i
            while j + 1 < n and flag[j + 1]:
                j += 1
            if (j - i + 1) <= max_frames:
                out[i:j + 1] = 1.0
            i = j + 1
        else:
            i += 1
    return out


def smooth1d(x, n):
    if n <= 1:
        return x
    k = np.ones(int(n)) / float(int(n))
    return np.convolve(x, k, mode="same")


# ------------------------------------------------------------------ 模型
def load_all(model_ckpt, device):
    from reflow.vocoder import load_model_vocoder
    from ddsp.vocoder import Volume_Extractor, Units_Encoder
    model, vocoder, args = load_model_vocoder(model_ckpt, device=device)
    gate = args.data.cnhubertsoft_gate if args.data.encoder == "cnhubertsoftfish" else 10
    ue = Units_Encoder(args.data.encoder, args.data.encoder_ckpt,
                       args.data.encoder_sample_rate, args.data.encoder_hop_size,
                       cnhubertsoft_gate=gate, device=device)
    return model, vocoder, args, ue


def rmvpe_raw(f0ext, audio, device):
    """复刻 F0_Extractor 的 rmvpe 分支，一次拿到 (f0@10ms, voicing_conf@10ms)。

    conf = hidden.max(dim=2)，与 encoder/rmvpe/utils.py 里 uv 判定同源，
    是 0..1 的**连续**置信度（官方只用它做 < thred 的硬判定，信息被丢掉一半）。
    """
    from encoder.rmvpe.utils import to_local_average_f0
    from torchaudio.transforms import Resample
    r = f0ext.rmvpe
    sr = f0ext.sample_rate
    a = torch.from_numpy(np.ascontiguousarray(audio, dtype=np.float32)).float().unsqueeze(0).to(device)
    if sr == 16000:
        a16 = a
    else:
        key = str(sr)
        if key not in r.resample_kernel:
            r.resample_kernel[key] = Resample(sr, 16000, lowpass_filter_width=128)
        r.resample_kernel[key] = r.resample_kernel[key].to(device)
        a16 = r.resample_kernel[key](a)
    r.model = r.model.to(device)
    mel_ex = r.mel_extractor.to(device)
    mel = mel_ex(a16, center=True)
    hidden = r.mel2hidden(mel)
    conf = hidden.max(dim=2)[0].squeeze(0).detach().cpu().numpy().astype(np.float64)
    f0 = to_local_average_f0(hidden, thred=0.03)
    f0 = np.asarray(f0).reshape(-1).astype(np.float64)
    return f0, conf


def f0_and_conf(f0ext, audio, device):
    """得到 (f0 目标帧率, conf 目标帧率) —— 与官方 uv_interp=True 口径对齐。"""
    hop = f0ext.hop_size
    sr = f0ext.sample_rate
    n_frames = int(len(audio) // hop) + 1
    f10, c10 = rmvpe_raw(f0ext, audio, device)
    uv10 = f10 == 0
    f10i = f10.copy()
    if (~uv10).sum() > 0:
        f10i[uv10] = np.interp(np.where(uv10)[0], np.where(~uv10)[0], f10[~uv10])
    origin = 0.01 * np.arange(len(f10i))
    target = hop / sr * np.arange(n_frames)
    f0 = np.interp(target, origin, f10i)
    conf = np.interp(target, origin, c10)
    f0 = np.pad(f0, (0, max(0, n_frames - len(f0))))[:n_frames]
    conf = np.pad(conf, (0, max(0, n_frames - len(conf))))[:n_frames]
    f0 = f0.copy()
    f0[f0 < f0ext.f0_min] = f0ext.f0_min
    return f0, conf


def crepe_uv_mask(audio, sr, n_frames, hop, device, th=0.35):
    """独立的 unvoiced 判据：源音频上的 torchcrepe periodicity。

    为什么需要它：rmvpe 会把某些清擦音（如「啸」的 /ɕ/）判成 voiced，
    这时 conf 很高、引导权重为 0 ⇒ 谐波激励照发，浊化修不掉（实测 5.0s 顽固 12%）。
    crepe 的 periodicity 是**独立的第二条证据链**：清擦音是无周期噪声 ⇒ pd 低。
    """
    import librosa
    import torchcrepe
    SR16, H16 = 16000, 160
    a16 = librosa.resample(np.asarray(audio, dtype=np.float32), orig_sr=sr, target_sr=SR16)
    x = torch.from_numpy(np.ascontiguousarray(a16)).float().unsqueeze(0)   # 走 CPU，避免与 DDSP 抢显存
    with torch.no_grad():
        f0, pd = torchcrepe.predict(x, SR16, model="full", hop_length=H16,
                                    fmin=50, fmax=1500, batch_size=512,
                                    device="cpu", return_periodicity=True)
    pd = pd.squeeze().cpu().numpy().astype(np.float64)
    tt = hop / sr * np.arange(n_frames)
    co = H16 / SR16 * np.arange(len(pd))
    pdt = np.clip(np.interp(tt, co, pd), 0.0, 1.0)
    return (pdt < th).astype(np.float64), pdt


# ------------------------------------------------------------------ 渲染
def render(audio, sr, model, vocoder, args, ue, f0ext, vol_ext, device,
           key=0.0, amp=0.0, nsf_uv=1, conf_hi=0.30, conf_lo=0.10,
           nsf_thred=0.20, smooth_ms=60.0, max_uv_ms=350.0, thred=-60.0,
           infer_step=50, method="euler", t_start=0.7, verify_official=False,
           crepe_uv=0, crepe_th=0.35):
    """按引导参数渲染一段。amp=0 且 nsf_uv=0 时退化为官方口径（对照组）。"""
    from ddsp.core import upsample

    msr = args.data.sampling_rate
    hop = args.data.block_size * sr / msr
    win = args.data.volume_smooth_size * sr / msr
    bs = int(args.data.block_size)

    f0, conf = f0_and_conf(f0ext, audio, device)

    if verify_official:
        from ddsp.vocoder import F0_Extractor
        ref = F0_Extractor("rmvpe", sr, hop, f0ext.f0_min, f0ext.f0_max)
        ref.rmvpe = f0ext.rmvpe
        fo = ref.extract(audio, uv_interp=True, device=device)
        n = min(len(fo), len(f0))
        print("    [校验] 复刻 f0 vs 官方 f0: 最大差 %.3f Hz  中位差 %.3f Hz"
              % (np.max(np.abs(fo[:n] - f0[:n])), np.median(np.abs(fo[:n] - f0[:n]))), flush=True)

    # ---- G3 引导权重（平滑 + 段长限制）----
    w = np.clip((conf_hi - conf) / max(conf_hi - conf_lo, 1e-6), 0.0, 1.0)
    uvh = (conf < nsf_thred).astype(np.float64)
    if crepe_uv:
        uvc, _pdc = crepe_uv_mask(audio, sr, len(f0), hop, device, th=crepe_th)
        w = np.maximum(w, uvc)      # 第二条证据链：源轨无周期 ⇒ 一定是清音
        uvh = np.maximum(uvh, uvc)
    w = w * limit_runs(w > 0.5, max_uv_ms * 1e-3 * sr / hop)
    w = smooth1d(w, max(3, int(round(smooth_ms * 1e-3 * sr / hop))))

    # ---- G1 DDSP 层：combtooth 谐波激励衰减 ----
    wt = torch.from_numpy((1.0 - amp * w).astype(np.float32)).to(device).view(1, -1, 1)
    wt = wt.repeat_interleave(bs, dim=1).view(1, -1)
    state = {"w": wt}
    orig_fsg = model.ddsp_model.fast_source_gen

    def patched_fsg(f0_frames):
        c = orig_fsg(f0_frames)
        ww = state["w"]
        if ww.shape[1] < c.shape[1]:
            ww = F.pad(ww, (0, int(c.shape[1] - ww.shape[1])), value=1.0)
        return c * ww[:, :c.shape[1]]

    model.ddsp_model.fast_source_gen = patched_fsg

    try:
        f0t = torch.from_numpy(f0.astype(np.float32)).to(device).view(1, -1, 1) * (2 ** (key / 12.0))
        vol = vol_ext.extract(audio)
        mk = (vol > 10 ** (thred / 20)).astype(np.float64)
        mk_t = torch.from_numpy(mk.astype(np.float32)).to(device).view(1, -1, 1)
        mask = upsample(mk_t, bs).squeeze(-1)
        vol_t = torch.from_numpy(vol.astype(np.float32)).to(device).view(1, -1, 1)
        aud_t = torch.from_numpy(np.ascontiguousarray(audio, dtype=np.float32)).float().view(1, -1).to(device)
        units = ue.encode(aud_t, sr, hop)
        spk = torch.LongTensor([[1]]).to(device)
        aug = torch.from_numpy(np.array([[0.0]], dtype=np.float32)).to(device)

        with torch.no_grad():
            mel = model(units, f0t, vol_t, spk_id=spk, spk_mix_dict=None,
                        aug_shift=aug, vocoder=vocoder, infer=True,
                        infer_step=infer_step, method=method, t_start=t_start)
            # ---- G2 NSF 层：uv 帧 f0 置 0 ----
            f0_nsf = f0t.clone()
            if nsf_uv:
                g = torch.from_numpy((1.0 - uvh).astype(np.float32)).to(device).view(1, -1)
                f0_nsf[0, :, 0] = f0_nsf[0, :, 0] * g[0, :f0_nsf.shape[1]]
            out = vocoder.infer(mel, f0_nsf)
            L = min(out.shape[-1] if out.dim() > 1 else out.shape[0], mask.shape[-1])
            out = out.reshape(-1)[:L] * mask.reshape(-1)[:L]
            out = out.detach().cpu().numpy().astype(np.float32)
    finally:
        model.ddsp_model.fast_source_gen = orig_fsg

    return out, dict(w=w, conf=conf, uvh=uvh, f0=f0)
