"""Task-local conversion adapter. Pilot/full share the same renderer and parameters.

No external project is modified. baseline uses the installed batch implementation;
guided is an explicit experimental renderer, never a claim of listening acceptance.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile


def sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--src', required=True)
    p.add_argument('--out', required=True)
    p.add_argument('--model', required=True)
    p.add_argument('--ddsp-dir', required=True)
    p.add_argument('--backend', choices=['baseline', 'guided'], default='baseline')
    p.add_argument('--mode', choices=['pilot', 'full'], default='pilot')
    p.add_argument('--start', type=float, default=0)
    p.add_argument('--duration', type=float, default=25)
    p.add_argument('--key', type=float, required=True)
    p.add_argument('--step', type=int, default=50)
    p.add_argument('--method', choices=['euler', 'rk4'], default='euler')
    p.add_argument('--t-start', type=float, default=0.7)
    p.add_argument('--amp', type=float, default=0.5)
    p.add_argument('--nsfuv', type=int, choices=[0, 1], default=1)
    p.add_argument('--conf-hi', type=float, default=0.4)
    p.add_argument('--conf-lo', type=float, default=0.15)
    p.add_argument('--nsf-thred', type=float, default=0.4)
    p.add_argument('--crepe-uv', type=int, choices=[0, 1], default=1)
    p.add_argument('--crepe-th', type=float, default=0.35)
    p.add_argument('--inspect-only', action='store_true', help='CPU metadata/selection validation; no model load or writes')
    a = p.parse_args()
    import math
    if not all(math.isfinite(v) for v in [a.key, a.start, a.duration, a.t_start]) or a.start < 0 or a.duration <= 0 or a.step <= 0 or not 0 <= a.t_start <= 1:
        p.error('invalid key, time range, step or t-start')
    if a.mode == 'full' and a.start != 0:
        p.error('full mode starts at zero; use pilot for a selected interval')
    import soundfile as sf
    info = sf.info(a.src)
    if info.frames <= 0:
        p.error('empty input')
    start = round(a.start * info.samplerate) if a.mode == 'pilot' else 0
    end = min(info.frames, start + round(a.duration * info.samplerate)) if a.mode == 'pilot' else info.frames
    if start >= info.frames or end <= start:
        p.error('pilot selection is empty or outside input')
    selection = {'start': start / info.samplerate, 'duration': (end - start) / info.samplerate, 'inputDuration': info.duration}
    if a.inspect_only:
        print(json.dumps({'mode': a.mode, 'backend': a.backend, 'key': a.key, 'selection': selection, 'variantCount': 1, 'modelLoaded': False}))
        return
    root = Path(a.ddsp_dir).resolve()
    model = Path(a.model).resolve()
    output = Path(a.out).resolve()
    provenance = Path(str(output) + '.conversion.json')
    if output.exists() or provenance.exists():
        p.error('output already exists; use a new run directory')
    if not model.is_file() or not (model.parent / 'config.yaml').is_file():
        p.error('model and sibling config.yaml are required')
    output.parent.mkdir(parents=True, exist_ok=True)
    job = Path(tempfile.mkdtemp(prefix='.convert-', dir=output.parent))
    os.environ['NUMBA_CACHE_DIR'] = str(job / 'numba_cache')
    os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(root))
    os.chdir(root)
    y, sr = sf.read(a.src, start=start, stop=end, dtype='float32', always_2d=True)
    # Match the accepted 44.1 kHz pipeline. Resample only if source metadata differs.
    if sr != 44100:
        from scipy.signal import resample_poly
        from math import gcd
        d = gcd(sr, 44100)
        y = resample_poly(y, 44100 // d, sr // d, axis=0).astype('float32')
        sr = 44100
    inp = job / 'input'; out = job / 'output'
    inp.mkdir(); out.mkdir()
    sf.write(inp / 'lead.wav', y, sr, subtype='FLOAT')
    source = root / 'batch_infer.py'
    if a.backend == 'baseline':
        argv = [str(source), '-m', str(model), '-i', str(inp), '-o', str(out), '-k', str(a.key), '-id', '1', '-step', str(a.step), '-method', a.method, '-pe', 'rmvpe', '-ts', str(a.t_start), '-v', '0']
        sys.argv = argv
        # __file__ only redirects the batch implementation's F0 cache into this job.
        exec(compile(source.read_text(encoding='utf-8'), str(source), 'exec'), {'__name__': '__main__', '__file__': str(job / 'batch_infer.py')})
        rendered = out / 'lead.wav'
    else:
        import numpy as np
        import torch
        import guided_core as g
        from ddsp.vocoder import F0_Extractor, Volume_Extractor
        device = 'cuda' if torch.cuda.is_available() else 'cpu'
        net, vocoder, config, ue = g.load_all(str(model), device)
        f0 = F0_Extractor('rmvpe', sr, config.data.block_size, 50, 1100)
        vol = Volume_Extractor(config.data.block_size, config.data.volume_smooth_size)
        audio, _ = g.render(np.mean(y, axis=1), sr, net, vocoder, config, ue, f0, vol, device, key=a.key, amp=a.amp, nsf_uv=a.nsfuv, conf_hi=a.conf_hi, conf_lo=a.conf_lo, nsf_thred=a.nsf_thred, crepe_uv=a.crepe_uv, crepe_th=a.crepe_th, infer_step=a.step, method=a.method, t_start=a.t_start)
        rendered = out / 'lead.wav'
        sf.write(rendered, audio, sr, subtype='PCM_24')
        source = Path(__file__).with_name('guided_core.py')
        argv = None
    if not rendered.is_file() or sf.info(rendered).frames <= 0:
        raise RuntimeError('renderer did not produce valid audio')
    os.rename(rendered, output)
    record = {'status': 'rendered_not_listening_accepted', 'effective': vars(a), 'selection': selection, 'sourceSha256': sha(a.src), 'modelSha256': sha(model), 'configSha256': sha(model.parent / 'config.yaml'), 'rendererSha256': sha(source), 'outputSha256': sha(output), 'argv': argv, 'cacheDirectory': str(job)}
    with provenance.open('x', encoding='utf-8') as f:
        json.dump(record, f, ensure_ascii=False, indent=2)
    print(json.dumps({'output': str(output), 'provenance': str(provenance), 'selection': selection}))


if __name__ == '__main__':
    main()
