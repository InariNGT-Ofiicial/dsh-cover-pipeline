import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../src/index.js';
import { resolveConfig, bundledScripts } from '../src/config.js';
import { runStage } from '../src/execution.js';
import { FLOW, WORKFLOW_RULES, STAGES } from '../src/stages.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cover-workflow-'));
const cfg = resolveConfig({ probeDir: root, mixDir: root });
let passed = 0;

assert.equal(bundledScripts().length, 8);
assert.ok(bundledScripts().every((x) => x.ok), '8 core scripts must ship with the repo');
passed++;

assert.equal(FLOW.length, 9);
assert.equal(FLOW.find((x) => x.stage === 'S3').optional, true);
assert.equal(FLOW.find((x) => x.stage === 'S7').optional, undefined);
passed++;

for (const key of ['shift', 'mix', 'verify']) {
  const args = key === 'shift'
    ? { key: 0, instSrc: path.join(root, 'missing_inst.wav'), harmSrc: path.join(root, 'missing_harm.wav'), outDir: path.join(root, 'out') }
    : key === 'mix'
      ? { inst: path.join(root, 'a.wav'), lead: path.join(root, 'b.wav'), harm: path.join(root, 'c.wav'), out: path.join(root, 'm.wav') }
      : { wav: path.join(root, 'm.wav') };
  const requires = key === 'shift' ? [args.instSrc, args.harmSrc]
    : key === 'mix' ? [args.inst, args.lead, args.harm]
      : [args.wav];
  const result = await runStage(cfg, key, args, { requires, run: () => assert.fail('missing input must not launch') });
  assert.equal(result.ok, false);
  assert.equal(result.phase, 'precondition');
}
passed++;

const registry = new Map();
await apply({ logger: { info() {}, warn() {} }, get: () => ({ register: (d) => registry.set(d.name, d) }) }, cfg);
assert.equal(registry.size, 9);
assert.equal(registry.has('cover_qc'), false);
assert.equal(registry.has('cover_cut'), false);
assert.equal(registry.has('cover_release'), false);
passed++;

const plan = await registry.get('cover_plan').execute({});
assert.ok(plan.flow.length >= 9);
assert.equal(plan.decisions.length, 5);
assert.ok(plan.openQuestions.length > 0);
assert.match(WORKFLOW_RULES.join(' '), /用户听审/);
passed++;

assert.equal(STAGES.verify(cfg, { wav: 'test.wav' }).args.includes('--ref'), false);
assert.ok(STAGES.verify(cfg, { wav: 'test.wav', ref: 'reference.wav' }).args.includes('--ref'));
passed++;

console.log(JSON.stringify({ passed, total: 6, scope: 'core workflow; no QC/cut/release tools' }));
