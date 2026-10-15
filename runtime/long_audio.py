"""Bound GPU work while preserving the original baseline renderer per window.

All indexes are samples in the selected 44.1 kHz source, half-open intervals.
Core intervals partition the source. Context is discarded; overlap is mixed
at the SAME source indexes, never concatenated twice or time stretched.
"""
from pathlib import Path
import numpy as np
import soundfile as sf


def plan_windows(frames, sr=44100):
    if frames <= 0 or sr != 44100:
        raise ValueError('chunking requires nonempty 44.1kHz audio')
    hop = 512
    core = int(20 * sr // hop) * hop
    context = int(np.ceil(sr / hop)) * hop
    fade = 8 * hop
    windows = []
    for i, start in enumerate(range(0, frames, core)):
        end = min(start + core, frames)
        keep_start, keep_end = max(0, start - fade), min(frames, end + fade)
        render_start = max(0, (keep_start - context) // hop * hop)
        render_end = min(frames, int(np.ceil((keep_end + context) / hop)) * hop)
        windows.append(dict(index=i, name=f'chunk_{i:05d}.wav', coreStart=start, coreEnd=end,
                            keepStart=keep_start, keepEnd=keep_end, renderStart=render_start,
                            renderEnd=render_end, fadeSamples=fade))
    return windows


def write_windows(audio, sr, folder):
    windows = plan_windows(len(audio), sr)
    for w in windows:
        sf.write(Path(folder) / w['name'], audio[w['renderStart']:w['renderEnd']], sr, subtype='FLOAT')
    return windows


def stitch_windows(windows, frames, sr, folder, destination):
    """Fail closed on holes, reordered cores, invalid renders or missing tails."""
    total = np.zeros(frames, dtype=np.float64)
    weight = np.zeros(frames, dtype=np.float64)
    cursor = 0
    records = []
    for w in windows:
        a, b = w['coreStart'], w['coreEnd']
        if a != cursor or b <= a or b > frames:
            raise ValueError('chunk cores must partition source without gaps or duplicates')
        cursor = b
        p = Path(folder) / w['name']
        y, rate = sf.read(p, dtype='float32', always_2d=True)
        expected = w['renderEnd'] - w['renderStart']
        if rate != sr or y.shape[1] != 1 or not np.isfinite(y).all() or abs(len(y) - expected) > 512:
            raise ValueError(f'invalid chunk render format/duration: {p}')
        lo, hi = w['keepStart'], w['keepEnd']
        offset = lo - w['renderStart']
        if offset < 0 or offset + hi - lo > len(y):
            raise ValueError(f'renderer omitted required samples: {p}')
        x = y[offset:offset + hi - lo, 0].astype(np.float64)
        positions = np.arange(lo, hi, dtype=np.float64)
        f = w['fadeSamples']
        gain = np.ones(hi - lo, dtype=np.float64)
        if a > 0:
            gain *= np.clip((positions - (a - f)) / (2 * f), 0, 1)
        if b < frames:
            gain *= np.clip(((b + f) - positions) / (2 * f), 0, 1)
        total[lo:hi] += x * gain
        weight[lo:hi] += gain
        records.append({**w, 'renderedFrames': len(y), 'retainedFrames': hi - lo})
    if cursor != frames or not np.allclose(weight, 1, atol=1e-12, rtol=0):
        raise ValueError('chunk coverage/weight sum is not exactly one across source timeline')
    audio = total / weight
    sf.write(destination, audio, sr, subtype='PCM_24')
    return {'strategy': 'baseline_context_overlap', 'sourceFrames': frames, 'outputFrames': frames,
            'sampleRate': sr, 'coreSeconds': windows[0]['coreEnd'] / sr,
            'contextSeconds': 44544 / sr, 'crossfadeSeconds': 8192 / sr,
            'maximumRenderedSeconds': max((w['renderEnd'] - w['renderStart']) / sr for w in windows),
            'weightMin': float(weight.min()), 'weightMax': float(weight.max()),
            'timelineComplete': True, 'windows': records}
