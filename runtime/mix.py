"""Run the existing master chain without overwriting its shared trace.
Keep the accepted single normalization pass; do not optimize by quality scores.
"""
import argparse
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import os


def main():
    p = argparse.ArgumentParser()
    p.add_argument('--mix-dir', required=True)
    p.add_argument('--out', required=True)
    p.add_argument('--profile', choices=['standard', 'lowband-safe'], default='standard')
    p.add_argument('--target', type=float, default=-14)
    p.add_argument('--p', action='append')
    p.add_argument('--set', action='append', required=True)
    a = p.parse_args()
    output = Path(a.out).resolve(); trace = Path(str(output) + '.mix.json')
    if output.exists() or trace.exists():
        p.error('output/trace exists; use a fresh run path')
    import soundfile as sf
    tracks = dict(v.split('=', 1) for v in a.set)
    if set(tracks) != {'inst', 'lead', 'harm'}:
        p.error('exact inst/lead/harm inputs are required')
    info = [sf.info(v) for v in tracks.values()]
    if any(i.samplerate != 44100 or i.frames <= 0 for i in info) or max(i.duration for i in info) - min(i.duration for i in info) > 0.03:
        p.error('tracks must be 44.1kHz, nonempty, and aligned within 30ms; use same source interval')
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix='.mix-', dir=output.parent))
    script = Path(a.mix_dir) / 'mix_master.py'
    sys.dont_write_bytecode = True
    spec = importlib.util.spec_from_file_location('cover_mix_master', script)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    normalize = module.normalize_to_lufs
    module.normalize_to_lufs = lambda y, sr, target, limiter: normalize(y, sr, target, limiter, max_iter=1)
    args = argparse.Namespace(out=str(temporary/'master.wav'), profile=a.profile, target_lufs=a.target, p=a.p, set=a.set, no_reverb=False, no_deesser=False)
    record = module.run(args)
    rendered = Path(record['output']['path'])
    os.rename(rendered, output)
    record['output']['path'] = str(output)
    record['normalizationPassLimit'] = 1
    record['listeningAccepted'] = False
    with trace.open('x', encoding='utf-8') as f: json.dump(record, f, ensure_ascii=False, indent=2)


if __name__ == '__main__':
    main()
