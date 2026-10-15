"""Real CPU mixing adapter smoke test with synthetic signals, not singing/audio acceptance."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import numpy as np
import soundfile as sf

p=argparse.ArgumentParser();p.add_argument('--mix-dir',required=True);a=p.parse_args()
r=Path(tempfile.mkdtemp(prefix='cover-mix-cpu-',dir=os.environ.get('COVER_TEST_TMP')))
t=np.arange(88200)/44100
for name,freq in [('inst',110),('lead',440),('harm',660)]:
    sf.write(r/(name+'.wav'),np.column_stack([.05*np.sin(2*np.pi*freq*t),.045*np.sin(2*np.pi*freq*t+.2)]),44100,subtype='FLOAT')
script=Path(__file__).resolve().parents[1]/'runtime/mix.py'
base=[sys.executable,'-B',str(script),'--mix-dir',a.mix_dir,'--out',str(r/'master.wav'),'--target','-14']
for name in ['inst','lead','harm']:base+=['--set',name+'='+str(r/(name+'.wav'))]
v=subprocess.run(base,capture_output=True,text=True,encoding='utf-8',env={**os.environ,'PYTHONIOENCODING':'utf-8'});assert v.returncode==0,v.stderr
y,sr=sf.read(r/'master.wav');assert sr==44100 and len(y)==88200 and np.isfinite(y).all() and np.max(np.abs(y))<1
trace=json.loads((r/'master.wav.mix.json').read_text(encoding='utf-8'));assert trace['normalizationPassLimit']==1 and not trace['listeningAccepted']
v=subprocess.run(base,capture_output=True,text=True,encoding='utf-8',env={**os.environ,'PYTHONIOENCODING':'utf-8'});assert v.returncode!=0 and 'exists' in v.stderr
sf.write(r/'harm.wav',np.zeros(44100),44100)
base[base.index('--out')+1]=str(r/'mismatch.wav')
v=subprocess.run(base,capture_output=True,text=True,encoding='utf-8',env={**os.environ,'PYTHONIOENCODING':'utf-8'});assert v.returncode!=0 and 'aligned' in v.stderr
print(json.dumps({'scope':'real CPU mix with synthetic sine waves, no voice model/GPU','passed':3,'output':str(r/'master.wav'),'checks':['finite aligned PCM output and independent one-pass trace','refuse overwrite','refuse mismatched track durations']}))
