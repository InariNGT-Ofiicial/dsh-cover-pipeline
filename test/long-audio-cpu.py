"""Real adapter + deterministic identity renderer; no GPU/model-quality claim."""
import importlib.util,json,os,subprocess,sys,tempfile
from pathlib import Path
import numpy as np
import soundfile as sf
base=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('long_audio',base/'runtime/long_audio.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=Path(tempfile.mkdtemp(prefix='long-audio-',dir=os.environ.get('COVER_TEST_TMP')))
passed=[]
sr=44100;core=int(20*sr//512)*512
for n in [1,core,core+1,2*core,2*core+1,286720*sr//1000]:
 w=m.plan_windows(n);assert w[0]['coreStart']==0 and w[-1]['coreEnd']==n
 assert all(b['coreStart']==a['coreEnd'] for a,b in zip(w,w[1:]));assert max(x['renderEnd']-x['renderStart'] for x in w)<=core+2*(44544+4096)
passed.append('long/exact-boundary/one-sample-tail plans cover every source sample with bounded windows')
# Nonperiodic deterministic signal detects any omission, duplication or offset.
for n in [core+1,2*core+1,3*core+731]:
 job=root/str(n);job.mkdir();rng=np.random.default_rng(7);x=rng.uniform(-.5,.5,n).astype('float32')
 w=m.write_windows(x,sr,job);out=job/'joined.wav';record=m.stitch_windows(w,n,sr,job,out);y,rate=sf.read(out)
 assert len(y)==len(x) and np.max(abs(y-x))<2e-7
 assert record['weightMin']==record['weightMax']==1
passed.append('identity renderer reconstruction at every sample including overlaps and one-sample tail; error <2e-7')
bad=m.plan_windows(2*core+1);bad[1]['coreStart']+=1
try:m.stitch_windows(bad,2*core+1,sr,root/str(2*core+1),root/'bad.wav');raise AssertionError('gap accepted')
except ValueError:pass
passed.append('malformed timeline rejected')
tail=root/str(2*core+1);tail_plan=m.plan_windows(2*core+1);last=tail/tail_plan[-1]['name'];original=last.read_bytes()
sf.write(last,np.zeros(10),sr)
try:m.stitch_windows(tail_plan,2*core+1,sr,tail,root/'missing-tail.wav');raise AssertionError('truncated tail accepted')
except ValueError:pass
last.write_bytes(original)
passed.append('truncated rendered tail rejected instead of padding or silently dropping source')
job=root/'adapter';job.mkdir();(job/'model.pt').write_bytes(b'fixture');(job/'config.yaml').write_text('data: {}')
(job/'batch_infer.py').write_text("import sys,pathlib,soundfile as sf,numpy as np\na=sys.argv;i=pathlib.Path(a[a.index('-i')+1]);o=pathlib.Path(a[a.index('-o')+1]);assert a[a.index('-step')+1]=='50' and a[a.index('-method')+1]=='euler'\nfor p in sorted(i.glob('*.wav')):\n y,s=sf.read(p,always_2d=True);assert len(y)<=23*s;sf.write(o/p.name,y.mean(axis=1),s,subtype='FLOAT')\n",encoding='utf8')
n=3*core+731;x=np.random.default_rng(12).uniform(-.5,.5,n).astype('float32');sf.write(job/'source.wav',x,sr,subtype='FLOAT')
cmd=[sys.executable,'-B',str(base/'runtime/convert.py'),'--src',str(job/'source.wav'),'--out',str(job/'result.wav'),'--model',str(job/'model.pt'),'--ddsp-dir',str(job),'--key','0','--mode','full']
v=subprocess.run(cmd,capture_output=True,text=True,encoding='utf8');assert v.returncode==0,v.stderr
y,_=sf.read(job/'result.wav');assert len(y)==n and np.max(abs(y-x))<2e-7
p=json.loads((job/'result.wav.conversion.json').read_text());assert p['chunking']['timelineComplete'] and p['effective']['step']==50
passed.append('actual full adapter dispatches bounded baseline windows and records provenance with unchanged parameters')
# A failing later render must not publish a partial success or provenance.
(job/'batch_infer.py').write_text("raise RuntimeError('fixture late-render failure')",encoding='utf8')
cmd[cmd.index('--out')+1]=str(job/'failed.wav');v=subprocess.run(cmd,capture_output=True,text=True,encoding='utf8')
assert v.returncode!=0 and not (job/'failed.wav').exists() and not (job/'failed.wav.conversion.json').exists()
passed.append('renderer failure cannot publish partial full-song output')
print(json.dumps({'scope':'CPU identity renderer, no voice inference','passed':len(passed),'results':passed,'root':str(root)},indent=2))
