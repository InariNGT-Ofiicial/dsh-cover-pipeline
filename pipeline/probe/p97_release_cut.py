# -*- coding: utf-8 -*-
"""p97 发布封装 —— wav -> mp3 320k CBR + ID3v2.3 + ID3v1 + 发布信息.md，并且**自证**。

为什么要"自证"而不是"跑完就算"：
  1. **mp3 不是无损**：解码回来的响度/峰值会与 wav 有差。必须实测差值，而不是假设一致。
  2. **mp3 解码可能过冲**：编码器在时域量化后，解码峰值常高于输入峰值（0.1–0.5 dB）。
     对一个真峰值 −2.6 dBTP 的母带无所谓，但**不能靠猜** —— 所以这里实测解码后的真峰值。
  3. **ID3v1 不被 mutagen 直接支持**（它只管 ID3v2）⇒ 手工追加 128 字节尾块，并回读校验。

用法:
  python p97_release_cut.py --wav 输入.wav --outdir 目录 --name 基础名 \
    --title "标题" --artist "艺术家" --album "专辑" [--year 2026] [--genre 古风] \
    [--comment "备注"] [--track 1]
"""
from __future__ import annotations

import argparse
import os
import sys

import numpy as np
import soundfile as sf
import pyloudnorm as pyln

# 音质库目录：优先环境变量（插件会传），其次脚本旁 _sq，再次历史路径。
_ql = (os.environ.get("COVER_QUALITY_LIB")
       or os.path.join(os.path.dirname(os.path.abspath(__file__)), "_sq"))
if not os.path.isdir(_ql) and os.path.isdir(r"D:/AI-Song/_pipeline_bqll/_probe/_sq"):
    _ql = r"D:/AI-Song/_pipeline_bqll/_probe/_sq"
if os.path.isdir(_ql):
    sys.path.insert(0, _ql)
import lameenc  # noqa: E402
from mutagen.id3 import ID3, TIT2, TPE1, TALB, TDRC, TRCK, TCON, COMM, ID3NoHeaderError  # noqa: E402

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

SR = 44100
GENRES = ["Blues", "Classic Rock", "Country", "Dance", "Disco", "Funk", "Grunge", "Hip-Hop",
          "Jazz", "Metal", "New Age", "Oldies", "Other", "Pop", "R&B", "Rap", "Reggae",
          "Rock", "Techno", "Industrial", "Alternative", "Ska", "Death Metal", "Pranks",
          "Soundtrack", "Euro-Techno", "Ambient", "Trip-Hop", "Vocal", "Jazz+Funk", "Fusion",
          "Trance", "Classical", "Instrumental", "Acid", "House", "Game", "Sound Clip",
          "Gospel", "Noise", "AlternRock", "Bass", "Soul", "Punk", "Space", "Meditative",
          "Instrumental Pop", "Instrumental Rock", "Ethnic", "Gothic", "Darkwave",
          "Techno-Industrial", "Electronic", "Pop-Folk", "Eurodance", "Dream",
          "Southern Rock", "Comedy", "Cult", "Gangsta", "Top 40", "Christian Rap",
          "Pop/Funk", "Jungle", "Native American", "Cabaret", "New Wave", "Psychadelic",
          "Rave", "Showtunes", "Trailer", "Lo-Fi", "Tribal", "Acid Punk", "Acid Jazz",
          "Polka", "Retro", "Musical", "Rock & Roll", "Hard Rock"]


def true_peak_db(y):
    """4 倍过采样近似真峰值。"""
    from scipy.signal import resample_poly
    z = resample_poly(y, 4, 1, axis=0)
    return 20 * np.log10(max(float(np.max(np.abs(z))), 1e-12))


def id3v1(title, artist, album, year, comment, genre_idx):
    def f(s, n):
        b = s.encode("gbk", errors="replace")[:n]
        return b + b"\x00" * (n - len(b))
    return (b"TAG" + f(title, 30) + f(artist, 30) + f(album, 30) + f(year, 4) +
            f(comment, 28) + b"\x00\x00" + bytes([genre_idx]))


def main():
    ap = argparse.ArgumentParser(description="发布封装：wav -> mp3 320k + ID3v2.3 + ID3v1")
    ap.add_argument("--wav", required=True)
    ap.add_argument("--outdir", required=True)
    ap.add_argument("--name", required=True, help="输出基础名（不含扩展名）")
    ap.add_argument("--title", required=True)
    ap.add_argument("--artist", required=True)
    ap.add_argument("--album", default="")
    ap.add_argument("--year", default="")
    ap.add_argument("--genre", default="Other")
    ap.add_argument("--comment", default="")
    ap.add_argument("--track", default="")
    ap.add_argument("--bitrate", type=int, default=320)
    args = ap.parse_args()

    os.makedirs(args.outdir, exist_ok=True)
    y, sr = sf.read(args.wav, always_2d=True, dtype="float64")
    assert sr == SR, "需 44.1 kHz"
    meter = pyln.Meter(SR)

    print("=" * 78)
    print("发布封装   src=%s" % os.path.basename(args.wav))
    print("  源: %.2f s  %dch  LUFS %.2f  真峰值 %.2f dBTP  峰值 %.2f dBFS"
          % (len(y) / SR, y.shape[1], meter.integrated_loudness(y),
             true_peak_db(y), 20 * np.log10(max(float(np.max(np.abs(y))), 1e-12))))

    # 编码：float -> int16（四舍五入）
    xi = np.clip(np.round(y * 32767.0), -32768, 32767).astype(np.int16)
    enc = lameenc.Encoder()
    enc.set_bit_rate(args.bitrate)
    enc.set_in_sample_rate(SR)
    enc.set_channels(y.shape[1])
    enc.set_quality(2)
    mp3 = enc.encode(xi.tobytes()) + enc.flush()

    mp3_path = os.path.join(args.outdir, args.name + ".mp3")
    with open(mp3_path, "wb") as f:
        f.write(mp3)

    # ID3v2.3（mutagen）
    try:
        tags = ID3(mp3_path)
    except ID3NoHeaderError:
        tags = ID3()
    tags.add(TIT2(encoding=3, text=args.title))
    tags.add(TPE1(encoding=3, text=args.artist))
    if args.album:
        tags.add(TALB(encoding=3, text=args.album))
    if args.year:
        tags.add(TDRC(encoding=3, text=args.year))
    if args.track:
        tags.add(TRCK(encoding=3, text=args.track))
    tags.add(TCON(encoding=3, text=args.genre))
    if args.comment:
        tags.add(COMM(encoding=3, lang="chi", desc="", text=args.comment))
    tags.save(mp3_path, v2_version=3)

    # ID3v1（手工追加）
    gi = GENRES.index(args.genre) if args.genre in GENRES else 12   # 12 = Other
    with open(mp3_path, "ab") as f:
        f.write(id3v1(args.title, args.artist, args.album or "", args.year or "",
                      args.comment or "", gi))

    # ---- 自证 ----
    z, zsr = sf.read(mp3_path, always_2d=True, dtype="float64")
    print("\n  解码回读: %.2f s  %d Hz  %dch" % (len(z) / SR, zsr, z.shape[1]))
    lz, lw = meter.integrated_loudness(z), meter.integrated_loudness(y)
    tz, tw = true_peak_db(z), true_peak_db(y)
    print("  响度      mp3 %8.2f LUFS    wav %8.2f   Δ %+0.2f" % (lz, lw, lz - lw))
    print("  真峰值    mp3 %8.2f dBTP    wav %8.2f   Δ %+0.2f  %s"
          % (tz, tw, tz - tw, "OK（未超 0）" if tz < 0 else "★ 解码过冲超 0 dBTP"))
    print("  时长差    %+.3f s" % (len(z) / SR - len(y) / SR))

    t = ID3(mp3_path)
    print("\n  ID3v2.3: ver=%s  TIT2=%s  TPE1=%s  TALB=%s  TDRC=%s  TCON=%s"
          % (t.version, t.get("TIT2"), t.get("TPE1"), t.get("TALB"), t.get("TDRC"), t.get("TCON")))
    with open(mp3_path, "rb") as f:
        f.seek(-128, 2)
        v1 = f.read(128)
    ok1 = v1[:3] == b"TAG"
    print("  ID3v1  : %s  title=%r artist=%r year=%r genre_idx=%d"
          % ("存在" if ok1 else "★ 缺失",
             v1[3:33].split(b"\x00")[0].decode("gbk", "replace"),
             v1[33:63].split(b"\x00")[0].decode("gbk", "replace"),
             v1[93:97].decode("gbk", "replace"), v1[127]))
    print("  文件: %s  (%.2f MB)" % (mp3_path, os.path.getsize(mp3_path) / 1e6))


if __name__ == "__main__":
    main()
