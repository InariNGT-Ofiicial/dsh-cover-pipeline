"""Read effective model configuration without loading torch or allocating a GPU."""
import argparse
import hashlib
import json
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument('--model', required=True)
p.add_argument('--ddsp-dir', required=True)
a = p.parse_args()
try:
    import yaml
    model = Path(a.model).resolve()
    config_file = model.parent / 'config.yaml'
    config = yaml.safe_load(config_file.read_text(encoding='utf-8'))
    assets = [model, config_file]
    for value in [config['data']['encoder_ckpt'], config['vocoder']['ckpt']]:
        asset = Path(value)
        assets.append(asset if asset.is_absolute() else Path(a.ddsp_dir) / asset)
    missing = [str(f) for f in assets if not f.is_file()]
    if missing:
        raise ValueError('Missing effective assets: ' + ', '.join(missing))
    if config['data']['sampling_rate'] != 44100:
        raise ValueError('This mixing recipe requires a 44.1 kHz model')
    print(json.dumps({'ok': True, 'model': str(model), 'config': str(config_file), 'samplingRate': config['data']['sampling_rate'], 'assets': [str(f) for f in assets]}))
except Exception as e:
    print(json.dumps({'ok': False, 'error': str(e)}))
    raise SystemExit(1)
