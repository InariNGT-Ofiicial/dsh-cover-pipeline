/**
 * test/harness.mjs —— 不重启 DSH 就能验证插件。
 *
 * 为什么需要它：DSH 的插件要装进 profile 并**重启**才生效，
 * 而"重启一次只看有没有报错"太慢、也看不出契约错误。
 * 这里用 mock ctx 直接把插件加载起来，逐条校验四件事：
 *   ① 导出契约（name / inject / apply）
 *   ② 工具注册数量与定义形状（含 parameters 与 output.schema 的 JSON Schema 健全性）
 *   ③ **输出契约**：execute 实际返回的字段必须与声明的 schema 相容
 *      —— 特别是 additionalProperties:false 下多返回字段会被拒收
 *   ④ 真的能跑：doctor / plan / status 实执行，其余工具 dry-run 回显命令行
 *
 * 用法: node test/harness.mjs        （退出码 0 = 全绿）
 */
import assert from 'node:assert/strict';
import * as plugin from '../src/index.js';

const EXPECTED_TOOLS = [
  'cover_doctor', 'cover_plan', 'cover_status', 'cover_separate', 'cover_shift',
  'cover_convert', 'cover_mix', 'cover_verify', 'cover_qc', 'cover_cut', 'cover_release',
];

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✅ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, msg: err?.message ?? String(err) });
    console.log(`  ❌ ${name}\n       ${err?.message ?? err}`);
  }
}

// ── ② 工具定义形状校验 ──────────────────────────────────────────────────
function validateSchema(path, s) {
  assert.ok(s && typeof s === 'object', `${path}: 不存在`);
  assert.equal(s.type, 'object', `${path}: 根类型必须是 object`);
  assert.ok(s.properties && typeof s.properties === 'object', `${path}: 缺 properties`);
  for (const [k, v] of Object.entries(s.properties)) {
    assert.ok(v && typeof v.type === 'string', `${path}.${k}: 缺 type`);
    if (v.type === 'array') assert.ok(v.items, `${path}.${k}: array 必须给 items`);
  }
  if (s.required) {
    for (const r of s.required) {
      assert.ok(r in s.properties, `${path}: required 里的 "${r}" 不在 properties 中`);
    }
  }
  assert.equal(s.additionalProperties, false, `${path}: 必须显式 additionalProperties:false`);
}

// ── ③ 输出契约校验 ──────────────────────────────────────────────────────
function validateOutput(toolName, schema, value) {
  if (!schema || schema.type !== 'object') return;
  assert.ok(value && typeof value === 'object', `${toolName}: execute 必须返回对象`);
  const props = Object.keys(schema.properties ?? {});
  for (const k of Object.keys(value)) {
    assert.ok(
      props.includes(k),
      `${toolName}: 返回值多出未声明字段 "${k}" —— additionalProperties:false 会拒收`,
    );
  }
  for (const r of schema.required ?? []) {
    assert.ok(r in value, `${toolName}: 返回值缺必需字段 "${r}"`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('== dsh-cover-pipeline 契约自检 ==\n');

console.log('[1] 导出契约');
await check('导出 name / inject / apply', () => {
  assert.equal(typeof plugin.name, 'string');
  assert.ok(Array.isArray(plugin.inject), 'inject 必须是数组');
  assert.equal(typeof plugin.apply, 'function');
});

console.log('\n[2] 注册');
const registry = new Map();
const warns = [];
const ctx = {
  logger: {
    info: () => {},
    warn: (...a) => warns.push(a.join(' ')),
    error: (...a) => warns.push(a.join(' ')),
  },
  get: (svc) => (svc === 'tools' ? { register: (d) => registry.set(d.name, d) } : undefined),
};
await plugin.apply(ctx, {});
await check(`注册了 ${EXPECTED_TOOLS.length} 个工具`, () =>
  assert.equal(registry.size, EXPECTED_TOOLS.length, `实际 ${registry.size}: ${[...registry.keys()].join(',')}`));
for (const n of EXPECTED_TOOLS) {
  await check(`工具存在: ${n}`, () => assert.ok(registry.has(n), '未注册'));
}

console.log('\n[3] 定义形状 + JSON Schema 健全性');
for (const [n, d] of registry) {
  await check(`${n} 定义完整`, () => {
    assert.ok(typeof d.description === 'string' && d.description.length > 20, '描述过短');
    validateSchema(`${n}.parameters`, d.parameters);
    assert.ok(d.output && typeof d.output === 'object', '缺 output');
    validateSchema(`${n}.output.schema`, d.output.schema);
    assert.equal(typeof d.output.render, 'function', 'output.render 必须是函数');
    assert.equal(typeof d.execute, 'function', 'execute 必须是函数');
  });
}

// ── 输出契约：render 必须返回 content blocks ────────────────────────────
console.log('\n[4] 真机执行与输出契约');
const CFG_LEAD = 'C:/AudioWork/fixtures/lead.wav';
const CFG_HARM = 'C:/AudioWork/fixtures/harm.wav';
const CFG_INST = 'C:/AudioWork/fixtures/instrumental.wav';

async function execRaw(n, args) {
  const d = registry.get(n);
  const v = await d.execute(args, {});
  validateOutput(n, d.output.schema, v);
  const blocks = d.output.render(args, v);
  assert.ok(Array.isArray(blocks) && blocks.length > 0, `${n}: render 必须返回非空数组`);
  for (const b of blocks) {
    assert.equal(b.type, 'text', `${n}: content block 目前只支持 type=text`);
    assert.equal(typeof b.text, 'string', `${n}: block.text 必须是字符串`);
  }
  return { v, blocks };
}

await check('cover_plan（实执行）', async () => {
  const { v, blocks } = await execRaw('cover_plan', { request: '把这首歌做成祥子的翻唱', preference: 'unknown' });
  assert.ok(v.flow.length >= 9, 'flow 应含 S0–S9');
  assert.ok(v.decisions.length === 5, 'decisions 应为 5 个');
  assert.ok(v.openQuestions.length > 0, '应给出待确认问题');
  assert.ok(blocks[0].text.includes('九段流程'));
});

await check('cover_status（实执行）', async () => {
  const { v } = await execRaw('cover_status', { depth: 1 });
  assert.equal(typeof v.exists, 'boolean');
  assert.ok(Array.isArray(v.entries));
});

let docOk = false;
await check('cover_doctor（实执行，含两套 Python 探测）', async () => {
  const { v, blocks } = await execRaw('cover_doctor', {});
  assert.ok(Array.isArray(v.checks) && v.checks.length >= 10, '检查项过少');
  assert.equal(typeof v.ok, 'boolean');
  docOk = v.ok;
  assert.equal(v.ok, true, 'doctor reported blocking environment errors');
  console.log(`       → ok=${v.ok} 阻塞=${v.errorCount} 警告=${v.warningCount}`);
  if (!v.ok) {
    for (const c of v.checks.filter((x) => !x.ok && x.level === 'error')) {
      console.log(`         ❌ ${c.name}: ${c.detail}`);
    }
  }
  assert.ok(blocks[0].text.length > 50);
});

console.log('\n[5] 其余工具 dry-run（回显命令行，不执行）');
const dryCases = [
  ['cover_separate', { inputFolder: 'C:/AudioWork/fixtures/00_src', outDir: 'D:/tmp/sep', dryRun: true }],
  ['cover_shift', { key: 5, outDir: 'D:/tmp/f5', instSrc: CFG_INST, harmSrc: CFG_HARM, dryRun: true }],
  ['cover_convert', { src: CFG_LEAD, key: 5, outDir: 'D:/tmp/f5', dryRun: true }],
  ['cover_mix', { inst: CFG_INST, lead: CFG_LEAD, harm: CFG_LEAD, out: 'D:/tmp/m.wav', dryRun: true }],
  ['cover_verify', { wav: CFG_LEAD, dryRun: true }],
  ['cover_qc', { kind: 'crack', lead: CFG_LEAD, ref: CFG_LEAD, a: 0, b: 30, dryRun: true }],
  ['cover_cut', { src: CFG_LEAD, out: 'D:/tmp/c.wav', segs: '46.27:69.00', dryRun: true }],
  ['cover_release', { wav: CFG_LEAD, outDir: 'D:/tmp', name: 'x', title: 't', artist: 'a', dryRun: true }],
];
for (const [n, args] of dryCases) {
  await check(`${n} dry-run`, async () => {
    const { v } = await execRaw(n, args);
    assert.equal(v.phase, 'dry-run', `期望 dry-run，实际 ${v.phase}：${v.error ?? ''}`);
    assert.ok(v.cmdline && v.cmdline.length > 10, '命令行为空');
    assert.ok(v.cmdline.includes('python.exe'), '命令应调用某套 Python 解释器');
    console.log(`       → ${v.cmdline.slice(0, 150)}${v.cmdline.length > 150 ? '…' : ''}`);
  });
}

// ── 汇总 ────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
console.log(`\n== 结果：${results.length - failed.length}/${results.length} 通过 ==`);
if (failed.length) {
  console.log('失败项:');
  for (const f of failed) console.log(`  ❌ ${f.name}\n     ${f.msg}`);
}
if (warns.length) console.log(`\n[warn] ${warns.join('\n[warn] ')}`);
if (!docOk) console.log('\nDoctor 未通过：环境契约检查失败，不能称环境就绪。');
process.exit(failed.length ? 1 : 0);
