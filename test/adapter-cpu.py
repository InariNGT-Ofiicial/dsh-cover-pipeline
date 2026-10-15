"""CPU-only executable adapter tests. No inference or user audio changes."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import wave

r = Path(tempfile.mkdtemp(prefix='cover-adapter-test-', dir=os.environ.get('COVER_TEST_TMP')))
source = r / 'short.wav'
with wave.open(str(source), 'wb') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(44100); w.writeframes(b'\0\0' * 44100)
script = Path(__file__).resolve().parents[1] / 'runtime' / 'convert.py'
base = [sys.executable, '-B', str(script), '--src', str(source), '--out', str(r/'never.wav'), '--model', str(r/'unused.pt'), '--ddsp-dir', str(r), '--key', '0', '--inspect-only']
results=[]
for backend in ['baseline', 'guided']:
    v = subprocess.run(base + ['--backend',backend],capture_output=True,text=True)
    assert v.returncode == 0, v.stderr
    j=json.loads(v.stdout);assert j['selection']['duration']==1 and j['key']==0 and j['variantCount']==1 and not j['modelLoaded']
    results.append(backend+' short pilot selects exactly one valid interval')
v=subprocess.run(base+['--start','1'],capture_output=True,text=True);assert v.returncode != 0
results.append('empty/outside selection rejected')
v=subprocess.run(base+['--mode','full'],capture_output=True,text=True);assert v.returncode==0 and json.loads(v.stdout)['selection']['duration']==1
results.append('full selection keeps entire source')
assert not (r/'never.wav').exists()
# Exercise the actual adapter with a tiny CPU renderer stand-in, not a voice model.
(r/'unused.pt').write_bytes(b'model-fixture')
(r/'config.yaml').write_text('data: {}',encoding='utf-8')
(r/'batch_infer.py').write_text("import sys,pathlib,shutil,json\na=sys.argv\ni=pathlib.Path(a[a.index('-i')+1]);o=pathlib.Path(a[a.index('-o')+1]);shutil.copyfile(i/'lead.wav',o/'lead.wav')\nprint(json.dumps(a))\n",encoding='utf-8')
execute=[v for v in base if v!='--inspect-only']
v=subprocess.run(execute,capture_output=True,text=True)
assert v.returncode==0,v.stderr
provenance=json.loads((r/'never.wav.conversion.json').read_text(encoding='utf-8'))
assert provenance['effective']['key']==0 and provenance['selection']['duration']==1 and '-k' in provenance['argv']
results.append('actual baseline adapter with CPU renderer stand-in writes exact output and provenance')
v=subprocess.run(execute,capture_output=True,text=True)
assert v.returncode!=0 and 'already exists' in v.stderr
results.append('existing output rejected by Python adapter too')
print(json.dumps({'scope':'real adapter with CPU renderer stand-in; no voice model/GPU loaded','passed':len(results),'results':results},indent=2))
