import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { optionalScriptCheck } from '../src/checks.js';
import { apply } from '../src/index.js';
import { resolveConfig, SCRIPTS, bundledScripts } from '../src/config.js';
import { runStage } from '../src/execution.js';
import { FLOW, WORKFLOW_RULES, STAGES } from '../src/stages.js';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'cover-workflow-'));
// scriptsDir 指到空目录，专门验证「脚本缺失时不得启动」
const cfg=resolveConfig({probeDir:root,scriptsDir:root});
assert.ok(bundledScripts().every(x=>x.ok),'15 bundled scripts must ship with the repo');
let passed=0;
for(const stage of ['S3','S8','S9'])assert.equal(FLOW.find(x=>x.stage===stage).optional,true);
assert.equal(FLOW.find(x=>x.stage==='S7').optional,undefined);passed++;
for(const key of ['voicedCheck','crackFix','instProfile','shiftVerify','abGeneric','leadEqProbe'])assert.equal(SCRIPTS[key],undefined);
for(const key of ['shiftUniform','crackScan','convCheck','sectionCentroid','sourceSurvey','chorusCut','brightness','releaseCut'])assert.ok(SCRIPTS[key]);passed++;
for(const key of ['shift','cut','release','qcCrack','qcConv','qcSection','qcBright','qcSource']){
 const result=await runStage(cfg,key,{key:0,files:[]},{run:()=>assert.fail('missing optional script must not launch')});
 assert.equal(result.ok,false);assert.equal(result.phase,'precondition');assert.match(result.error,/Missing optional\/conditional tool script/);
}passed++;
// A configured optional tool remains callable; no blanket disable or automatic adjustment.
fs.writeFileSync(path.join(root,SCRIPTS.sourceSurvey),'fixture');
let calls=0;const result=await runStage(cfg,'qcSource',{files:[]},{run:async()=>{calls++;return {ok:true,code:0,stdout:'diagnostic only',stderr:''};}});
assert.equal(calls,1);assert.equal(result.ok,true);passed++;
const registry=new Map();await apply({logger:{info(){},warn(){}},get:()=>({register:d=>registry.set(d.name,d)})},cfg);
const plan=await registry.get('cover_plan').execute({});
assert.ok(plan.flow.some(x=>x.optional));assert.match(registry.get('cover_qc').description,/可选/);
assert.match(WORKFLOW_RULES.join(' '),/用户听审/);assert.equal(registry.size,12);passed++;
assert.equal(STAGES.verify(cfg,{wav:'test.wav'}).args.includes('--ref'),false);
assert.ok(STAGES.verify(cfg,{wav:'test.wav',ref:'reference.wav'}).args.includes('--ref'));passed++;
const optional=optionalScriptCheck(cfg);assert.equal(optional.level,'info');assert.equal(optional.ok,false);assert.match(optional.detail,/releaseCut/);passed++;
console.log(JSON.stringify({passed,total:7,scope:'workflow and real registered tool contract; no audio inference'}));
