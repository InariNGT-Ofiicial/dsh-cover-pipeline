/**
 * test/e2e.mjs —— 真机端到端：用插件自己的代码路径**真的跑一次 Python 流水线**。
 *
 * 为什么单独一个文件：harness 验的是"契约 + dry-run"，证明不了
 * spawn/cwd/超时/输出解析/产物自证这条真实链路。这里只跑**只读或轻量**的阶段，
 * 但走的是与生产中完全相同的 runStage 内核。
 *
 * ⚠️ 耗时提示：`p87`（换声有效性）内部要对两条整曲跑 librosa.pyin，约 5 分钟；
 *    `p89`（逐段质心）按窗口数计，约 1–2 分钟/窗口。属脚本固有成本，不是插件开销。
 *
 * 用法: node test/e2e.mjs
 */
import assert from 'node:assert/strict';
import * as plugin from '../src/index.js';

const results = [];
async function step(name, fn) {
  const t0 = Date.now();
  try {
    const info = await fn();
    const ms = Date.now() - t0;
    results.push({ name, ok: true });
    console.log(`  ✅ ${name}  (${(ms / 1000).toFixed(1)}s)${info ? `\n       ${info}` : ''}`);
  } catch (err) {
    results.push({ name, ok: false, msg: err?.message ?? String(err) });
    console.log(`  ❌ ${name}\n       ${err?.message ?? err}`);
  }
}

const registry = new Map();
const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  get: (s) => (s === 'tools' ? { register: (d) => registry.set(d.name, d) } : undefined),
};
await plugin.apply(ctx, {});
const call = (n, args) => registry.get(n).execute(args, {});

const DELIVER = 'D:/AI-Song/_交付/八千里路/成品_副歌裁剪/01_最终交付_+5key标准.wav';
const REF_LEAD = 'D:/AI-Song/_pipeline_bqll/02_conv/in_lead/lead.wav';
const K0_LEAD = 'D:/AI-Song/_pipeline_bqll/_probe/final0/lead_uniform_k+0.wav';

console.log('== dsh-cover-pipeline 真机端到端 ==\n');

await step('cover_verify 实操五门验收（对最终交付件）', async () => {
  const v = await call('cover_verify', {
    wav: DELIVER,
    json: 'D:/AI-Song/_pipeline_bqll/_probe/_plugin_e2e/verify.json',
  });
  assert.equal(v.phase, 'executed', `未进入执行相: ${v.error ?? ''}`);
  assert.equal(v.exitCode, 0, `exit=${v.exitCode}  stderr=${(v.stderr || '').slice(-400)}`);
  assert.ok((v.stdout || '').includes('[PASS]'), '输出里没有 [PASS] 行，验收未真正执行');
  assert.equal(v.artifactsOk, true, `产物校验未过: ${JSON.stringify(v.artifacts)}`);
  const pass = (v.stdout.match(/\[PASS\]/g) || []).length;
  const fail = (v.stdout.match(/\[FAIL\]/g) || []).length;
  assert.equal(fail, 0, `出现 ${fail} 个 FAIL`);
  return `五门 PASS ${pass} 项 / FAIL ${fail} 项 ｜ JSON 已落盘`;
});

await step('cover_qc(conv) 实操换声有效性（MFCC 距离）', async () => {
  const v = await call('cover_qc', { kind: 'conv', lead: K0_LEAD, ref: REF_LEAD });
  assert.equal(v.phase, 'executed', `未进入执行相: ${v.error ?? ''}`);
  assert.ok((v.stdout || '').includes('MFCC'), '输出里没有 MFCC 行');
  // ★ 只取加粗里的真值：行文形如「MFCC 距离（0=完全相同）: **151.71**」
  const m = (v.stdout || '').match(/MFCC 距离[^*]*\*\*([\d.]+)\*\*/);
  assert.ok(m, `未能解析出 MFCC 距离。原始输出尾部：\n${(v.stdout || '').slice(-500)}`);
  const d = Number(m[1]);
  assert.ok(d > 20, `MFCC 距离 ${d} 过小 —— 换声可能没生效`);
  return `MFCC 距离 = ${d}（>20 ⇒ 音色确已改变）`;
});

await step('cover_qc(section) 实操逐段质心（像不像目标音色）', async () => {
  const v = await call('cover_qc', {
    kind: 'section', lead: K0_LEAD, ref: REF_LEAD,
    win: ['副歌1 46.3-69.0:46.3:69.0', '副歌2 107.9-128.5:107.9:128.5'],
  });
  assert.equal(v.phase, 'executed', `未进入执行相: ${v.error ?? ''}`);
  assert.ok((v.stdout || '').includes('质心'), '输出里没有质心表');
  const rows = (v.stdout.match(/副歌[12][^\n]*/g) || []).length;
  assert.ok(rows >= 2, `期望 2 行段落结果，实际 ${rows}`);
  return `已量 ${rows} 段`;
});

await step('cover_status + 环境摘要', async () => {
  const v = await call('cover_status', { dir: 'D:/AI-Song/_pipeline_bqll/_probe/cut', depth: 1, envSummary: true });
  assert.ok(v.env, '未返回环境摘要（envSummary 未生效）');
  assert.match(v.env.msst, /py3\.10/, `MSST 环境异常: ${v.env.msst}`);
  // ★ JS 的 String(true) 是小写 true
  assert.match(v.env.ddsp, /cuda=true/, `DDSP 环境异常: ${v.env.ddsp}`);
  assert.ok(v.env.freeGB > 1, `磁盘读数异常: ${v.env.freeGB}`);
  return `MSST ${v.env.msst} ｜ DDSP ${v.env.ddsp} ｜ 磁盘 ${v.env.freeGB} GB`;
});

const failed = results.filter((r) => !r.ok);
console.log(`\n== 端到端：${results.length - failed.length}/${results.length} 通过 ==`);
process.exit(failed.length ? 1 : 0);
