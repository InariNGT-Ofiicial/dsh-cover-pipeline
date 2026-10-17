/**
 * dsh-cover-pipeline —— 自然语言驱动的 AI 翻唱全流程插件。
 *
 * Cordis 插件契约（实证自 dsh-qqbot 与 dsh 自带的 config tree）：
 *   export const name   = '<插件 id>'
 *   export const inject = ['tools']            // 声明式依赖注入
 *   export async function apply(ctx, config)   // 插件主体
 *   tools.register({ name, description, parameters, output, execute })
 *
 * ★ 零运行时依赖：只用 node: 内置模块。插件作者的原话值得照抄 ——
 *   "手写 ToolDefinition（标准 JSON Schema），避免引入 dsh-tools 的 8 个 peer 依赖"。
 *   依赖越少，越可能在任意 profile 里加载成功。
 */
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join as pjoin } from 'node:path';

import {
  resolveConfig, join, findVoice, listVoices, bundledScripts, LOCAL_CONFIG,
} from './config.js';
import { runStage, runSeparation } from './execution.js';
import { doctor, renderDoctor, probePython, diskFree } from './checks.js';
import { STAGES, FLOW, GATES, DECISIONS, WORKFLOW_RULES, keyTag } from './stages.js';

export const name = 'cover-pipeline';
export const inject = ['tools'];

// ───────────────────────────────────────────────────────────────────────────
// 通用工具
// ───────────────────────────────────────────────────────────────────────────

/** 列出目录一层的子目录及其 wav 数量与最新文件 */
function scanDir(dir, depth = 2) {
  if (!existsSync(dir)) return { dir, exists: false, entries: [] };
  const entries = [];
  const walk = (d, level) => {
    if (level > depth) return;
    for (const f of readdirSync(d, { withFileTypes: true })) {
      const full = pjoin(d, f.name);
      if (f.isDirectory()) {
        let wavs = 0;
        let newest = null;
        const stack = [full];
        while (stack.length) {
          const cur = stack.pop();
          for (const g of readdirSync(cur, { withFileTypes: true })) {
            const p = pjoin(cur, g.name);
            if (g.isDirectory()) stack.push(p);
            else if (/\.(wav|mp3|json|npz)$/i.test(g.name)) {
              if (/\.wav$/i.test(g.name)) wavs += 1;
              const st = statSync(p);
              if (!newest || st.mtimeMs > newest.mtimeMs) {
                newest = { name: g.name, mtimeMs: st.mtimeMs, sizeBytes: st.size };
              }
            }
          }
        }
        entries.push({ relPath: full.replace(/\\/g, '/'), wavCount: wavs, newest });
        walk(full, level + 1);
      }
    }
  };
  walk(dir, 1);
  return { dir, exists: true, entries: entries.slice(0, 60) };
}

function tail(s, n = 2500) {
  const t = String(s ?? '').trim();
  return t.length <= n ? t : `…\n${t.slice(-n)}`;
}

/**
 * 阶段执行内核：前置检查 → dry-run 或执行 → 产物自证。
 * 所有 stage 类工具都走这里，保证行为一致。
 */
/** 把阶段结果渲染成人读文本（各工具共用） */
function renderStage(title, v) {
  if (v.phase === 'dry-run') {
    return `【${title}｜预演】\n命令: ${v.cmdline}${v.cwd ? `\n工作目录: ${v.cwd}` : ''}`
      + (v.expects?.length ? `\n预期产物: ${v.expects.join(' , ')}` : '');
  }
  const head = `${v.ok ? '✅' : '❌'} ${title}${v.label ? `（${v.label}）` : ''}`
    + (v.ms ? `  ${(v.ms / 1000).toFixed(1)}s` : '')
    + (v.timedOut ? '  ⏱超时' : '')
    + (v.exitCode !== undefined && v.exitCode !== null ? `  exit=${v.exitCode}` : '');
  const lines = [head];
  if (v.error) lines.push(`  错误: ${v.error}`);
  if (v.cmdline) lines.push(`  命令: ${v.cmdline}`);
  if (v.artifacts?.length) {
    lines.push('  产物:');
    for (const a of v.artifacts) {
      lines.push(`    ${a.exists ? '✅' : '❌'} ${(a.sizeBytes / 1048576).toFixed(2)} MB  ${a.path}`);
    }
    if (v.artifactsOk === false) lines.push('  ★ 产物缺失或过小 —— 不视为成功');
  }
  if (v.stdout) lines.push(`  ── 输出尾部 ──\n${tail(v.stdout, 1800).split('\n').map((l) => `  ${l}`).join('\n')}`);
  if (v.stderr) lines.push(`  ── stderr 尾部 ──\n${tail(v.stderr, 1200).split('\n').map((l) => `  ${l}`).join('\n')}`);
  return lines.join('\n');
}

const textOut = (schema, fn) => ({ schema, render: (_a, v) => [{ type: 'text', text: fn(v) }] });

/** 阶段类工具统一的结果 schema */
const STAGE_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    phase: { type: 'string' },
    label: { type: 'string' },
    cmdline: { type: 'string' },
    cwd: { type: 'string' },
    expects: { type: 'array', items: { type: 'string' } },
    exitCode: { type: 'integer' },
    timedOut: { type: 'boolean' },
    ms: { type: 'integer' },
    error: { type: 'string' },
    artifactsOk: { type: 'boolean' },
    technicalChecksPassed: { type: 'boolean' },
    manifestPath: { type: 'string' },
    artifacts: {
      type: 'array',
      items: {
        type: 'object',
        properties: { path: { type: 'string' }, exists: { type: 'boolean' }, sizeBytes: { type: 'integer' } },
        required: ['path', 'exists', 'sizeBytes'],
        additionalProperties: false,
      },
    },
    stdout: { type: 'string' },
    stderr: { type: 'string' },
  },
  required: ['ok', 'phase'],
  additionalProperties: false,
};

/**
 * 在 STAGE_SCHEMA 基础上追加字段。
 * ★ 必须这么做：`additionalProperties:false` 下，execute 多返回一个字段就会被拒收 ——
 *   这个坑由 test/harness.mjs 的输出契约校验兜住。
 */
const stageSchemaWith = (props = {}, required = []) => ({
  ...STAGE_SCHEMA,
  properties: { ...STAGE_SCHEMA.properties, ...props },
  required: [...STAGE_SCHEMA.required, ...required],
});

// ───────────────────────────────────────────────────────────────────────────
// 插件主体
// ───────────────────────────────────────────────────────────────────────────

export async function apply(ctx, config) {
  const logger = ctx.logger ?? console;
  const cfg = resolveConfig(config);
  const tools = ctx.get('tools');
  if (!tools || typeof tools.register !== 'function') {
    logger.warn('[cover-pipeline] tools 服务不可用，插件未注册任何工具');
    return;
  }
  const registered = [];

  // ── 1 · 环境体检 ──────────────────────────────────────────────────────
  tools.register({
    name: 'cover_doctor',
    description:
      'AI 翻唱流水线的环境体检：检查两套 Python 环境（MSST / DDSP）及其模块、模型权重（HiFiGAN / ContentVec / 目标音色）、'
      + 'ffmpeg、音质库、随包 15 个流水线脚本（5 adapter + 8 probe + 2 mix/verify）、音色库、磁盘空间与代理。'
      + '★ 任何翻唱任务开始前先跑这个；它同时给出每项缺失的修复办法。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: textOut(
      {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          errorCount: { type: 'integer' },
          warningCount: { type: 'integer' },
          checks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' }, level: { type: 'string' },
                ok: { type: 'boolean' }, detail: { type: 'string' }, fix: { type: 'string' },
              },
              required: ['name', 'level', 'ok', 'detail'],
              additionalProperties: false,
            },
          },
          rendered: { type: 'string' },
        },
        required: ['ok', 'errorCount', 'warningCount', 'checks', 'rendered'],
        additionalProperties: false,
      },
      (v) => v.rendered,
    ),
    async execute() {
      const res = await doctor(cfg);
      const rendered = renderDoctor(res);
      logger.info(`[cover-pipeline] doctor: ok=${res.ok} errors=${res.errors.length} warnings=${res.warnings.length}`);
      return {
        ok: res.ok,
        errorCount: res.errors.length,
        warningCount: res.warnings.length,
        checks: res.checks.map(({ name: n, level, ok, detail, fix }) => ({ name: n, level, ok, detail, fix: fix ?? '' })),
        rendered,
      };
    },
  });

  // ── 1b · 一句话接入：自动发现 + 选音色 + 出配置 ───────────────────────
  tools.register({
    name: 'cover_setup',
    description:
      '一句话接入的入口：检查随包 15 个脚本、自动发现 MSST/DDSP/音色库、按名字选音色，'
      + '输出可直接使用的配置片段与缺失清单。默认只读；writeConfig=true 时写仓库根 cover.local.json'
      + '（git 忽略，优先级最高），**下次加载 DSH 生效**。',
    parameters: {
      type: 'object',
      properties: {
        root: { type: 'string', description: 'AI-Song 根目录（省略则自动发现 D:/AI-Song、C:/AudioWork 等）' },
        voice: { type: 'string', description: '默认音色名，如「祥子」' },
        writeConfig: { type: 'boolean', description: '把发现的路径写入 cover.local.json（默认 false）' },
      },
      additionalProperties: false,
    },
    output: textOut(
      {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          root: { type: 'string' },
          voice: { type: 'string' },
          voices: {
            type: 'array',
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, steps: { type: 'integer' }, model: { type: 'string' } },
              required: ['name', 'steps', 'model'],
              additionalProperties: false,
            },
          },
          missing: { type: 'array', items: { type: 'string' } },
          patch: { type: 'string' },
          wrote: { type: 'string' },
          rendered: { type: 'string' },
        },
        required: ['ok', 'root', 'voice', 'voices', 'missing', 'patch', 'wrote', 'rendered'],
        additionalProperties: false,
      },
      (v) => v.rendered,
    ),
    async execute(args) {
      const next = resolveConfig({ ...cfg, ...(args.root ? { songRoot: args.root } : {}) });
      const scripts = bundledScripts();
      const voices = next.voices;
      const picked = args.voice
        ? findVoice(next, args.voice)
        : (voices.find((v) => v.model === next.voiceModel) ?? null);
      const missing = [];
      const badScripts = scripts.filter((s) => !s.ok);
      if (badScripts.length) missing.push(`随包脚本缺 ${badScripts.length} 个: ${badScripts.map((s) => `${s.kind}/${s.file}`).join(', ')}`);
      for (const [label, p] of [
        ['MSST 目录', next.msstDir], ['DDSP 目录', next.ddspDir],
        ['MSST python', next.msstEnv], ['DDSP python', next.ddspEnv],
      ]) if (!p || !existsSync(p)) missing.push(`${label} 不存在: ${p || '(空)'}`);
      if (!next.voiceModel || !existsSync(next.voiceModel)) missing.push(`目标音色权重不存在: ${next.voiceModel || '(空)'}`);
      if (args.voice && !picked) missing.push(`音色库中没有 "${args.voice}"；可用: ${voices.map((v) => v.name).join(', ') || '（空）'}`);
      if (!existsSync(join(next.msstDir, 'pretrain/MelBandRoformer_kim.ckpt'))) missing.push('MSST kim 权重缺失（见 materials/README.md）');
      if (!existsSync(join(next.ddspDir, 'pretrain/contentvec/checkpoint_best_legacy_500.pt'))) missing.push('DDSP ContentVec 缺失（见 materials/README.md）');

      const keys = ['songRoot', 'pipelineRoot', 'probeDir', 'mixDir', 'msstDir', 'msstEnv',
        'ddspDir', 'ddspEnv', 'ffmpeg', 'voiceLibDir', 'voiceModel', 'qualityLibDir'];
      const yaml = (v) => `'${String(v ?? '').replace(/'/g, "''")}'`;
      const patch = ['config:', ...keys.map((k) => `  ${k}: ${yaml(next[k])}`)].join('\n');

      let wrote = '';
      if (args.writeConfig === true) {
        const local = {};
        for (const k of [...keys, 'scriptsDir', 'mixScriptDir']) local[k] = next[k] ?? '';
        if (picked) local.voiceModel = picked.model;
        writeFileSync(LOCAL_CONFIG, JSON.stringify(local, null, 2), 'utf8');
        wrote = LOCAL_CONFIG;
      }

      const lines = [
        `【一句话接入｜${next.songRoot || '(未发现根目录)'}】`,
        `随包脚本: ${scripts.filter((s) => s.ok).length}/${scripts.length}`,
        `音色库: ${voices.length} 个${voices.length ? ' — ' + voices.map((v) => `${v.name}(${v.steps}步)`).join(' / ') : ''}`,
        `选中音色: ${picked ? `${picked.name}(${picked.steps}步)  ${picked.model}` : '(未选中；可用 voice 指定)'}`,
        '',
        missing.length ? '── 还缺 ──' : '── 依赖齐全，可以开跑 ──',
        ...missing.map((m) => `  ❌ ${m}`),
        '',
        '配置片段（粘到 profile 的 `cordis.patch.yml` 的 `cover-pipeline.config` 下）：',
        patch,
        wrote ? `\n已写入本机覆盖层: ${wrote}\n★ 需要重启 DSH（或重新加载插件）才生效。` : '\n（只读模式；要落盘请加 writeConfig=true）',
        '',
        '下一步: 重启 DSH → cover_doctor → cover_plan → cover_separate',
      ];
      return {
        ok: missing.length === 0,
        root: next.songRoot ?? '',
        voice: picked?.name ?? '',
        voices: voices.map((v) => ({ name: v.name, steps: v.steps, model: v.model })),
        missing,
        patch,
        wrote,
        rendered: lines.join('\n'),
      };
    },
  });

  // ── 2 · 计划（把方法论交给模型）────────────────────────────────────────
  tools.register({
    name: 'cover_plan',
    description:
      '把一句自然语言翻唱需求，变成可执行的流水线计划：返回九段流程（S0–S9）、五个必须"量"而不能"猜"的决策点（D1–D5）、'
      + '五道验收门，以及**必须先向用户确认的问题清单**。'
      + '★ 在动手前调用；它不会替你猜音区/调性，而是告诉你要量什么。',
    parameters: {
      type: 'object',
      properties: {
        request: { type: 'string', description: '用户的原始自然语言需求（原样粘贴）' },
        songPath: { type: 'string', description: '源歌曲音频路径（若已知）' },
        voiceName: { type: 'string', description: '目标音色名（若已知）' },
        preference: {
          type: 'string',
          enum: ['prefer_voice', 'prefer_backing', 'prefer_length', 'unknown'],
          description: '用户偏好：保人声辨识度 / 保伴奏厚度 / 保时长 / 未知',
        },
      },
      required: ['request'],
      additionalProperties: false,
    },
    output: textOut(
      {
        type: 'object',
        properties: {
          flow: { type: 'array', items: { type: 'object', additionalProperties: true } },
          decisions: { type: 'array', items: { type: 'object', additionalProperties: true } },
          gates: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
          rules: { type: 'array', items: { type: 'string' } },
          openQuestions: { type: 'array', items: { type: 'string' } },
          rendered: { type: 'string' },
        },
        required: ['flow', 'decisions', 'gates', 'rules', 'openQuestions', 'rendered'],
        additionalProperties: false,
      },
      (v) => v.rendered,
    ),
    async execute(args) {
      const q = [];
      if (!args.songPath) q.push('源歌曲音频的路径？（需 44.1/48 kHz 的 mp3/wav/flac）');
      if (!args.voiceName) q.push('目标音色（用哪个音色模型）？');
      q.push('音区策略：整曲统一移调（保比例）还是分段（保音区、但会压缩副歌/主歌比例）？');
      q.push('和声默认保留原声（二级分离）；仅在用户明确选择时更换此策略。');
      if (!args.preference || args.preference === 'unknown') {
        q.push('若"人声更像目标音色"与"伴奏更厚"不可兼得，你要哪个？（本项目实测：非八度移调必然伤伴奏低频）');
      }
      q.push('交付形态：整曲 / 只副歌 / 只片段？要不要 mp3 发布包？');

      const rendered = [
        `【翻唱计划】需求原文：${args.request}`,
        args.songPath ? `源: ${args.songPath}` : '源: **未提供**',
        args.voiceName ? `目标音色: ${args.voiceName}` : '目标音色: **未提供**',
        '',
        '── 默认流程与可选步骤 ──',
        ...FLOW.map((f) => `  ${f.stage} ${f.name}  [工具 ${f.tool}]\n      ${f.detail}`),
        '',
        '── 配置决策 ──',
        ...DECISIONS.map((d) => `  ${d.id} ${d.name}\n      为什么: ${d.why}\n      怎么量: ${d.how}\n      铁律: ${d.rule}`),
        '',
        '── 技术指标（不代替听审；LRA 为报告项）──',
        ...GATES.map(([k, v]) => `  ${k}: ${v}`),
        '',
        '── 纪律 ──',
        ...WORKFLOW_RULES.map((r) => `  ${r}`),
        '',
        '── 需要先问用户的 ──',
        ...q.map((x, i) => `  ${i + 1}. ${x}`),
        '',
        '下一步：先 `cover_doctor`，再按 S1 开始（`cover_separate`）。',
      ].join('\n');

      return {
        flow: FLOW, decisions: DECISIONS, gates: GATES, rules: WORKFLOW_RULES,
        openQuestions: q, rendered,
      };
    },
  });

  // ── 3 · 状态勘探 ──────────────────────────────────────────────────────
  tools.register({
    name: 'cover_status',
    description:
      '勘探翻唱工程的当前状态：列出目录下各子目录的 wav 数量与最新产物，并可选做一次环境摘要。'
      + '用于"接着上次跑"——先看清已经有哪些中间件，别重复生成。',
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: '要勘探的目录（默认工程根的 probeDir）' },
        depth: { type: 'integer', description: '递归层数（默认 2）' },
        envSummary: { type: 'boolean', description: '是否附带两套 Python 环境的摘要' },
      },
      additionalProperties: false,
    },
    output: textOut(
      {
        type: 'object',
        properties: {
          dir: { type: 'string' },
          exists: { type: 'boolean' },
          entries: { type: 'array', items: { type: 'object', additionalProperties: true } },
          env: { type: 'object', additionalProperties: true },
          rendered: { type: 'string' },
        },
        required: ['dir', 'exists', 'entries', 'rendered'],
        additionalProperties: false,
      },
      (v) => v.rendered,
    ),
    async execute(args) {
      const dir = args.dir ? join(args.dir) : cfg.probeDir;
      const scan = scanDir(dir, args.depth ?? 2);
      const lines = [`【工程状态】${dir}${scan.exists ? '' : ' —— 不存在'}`];
      if (scan.exists) {
        for (const e of scan.entries) {
          const newest = e.newest
            ? `最新 ${e.newest.name} (${(e.newest.sizeBytes / 1048576).toFixed(1)} MB)`
            : '（无音频/产物）';
          lines.push(`  ${e.relPath.replace(dir, '.')}  wav×${e.wavCount}  ${newest}`);
        }
      }
      let env;
      if (args.envSummary) {
        const [m, d] = [await probePython(cfg.msstEnv), await probePython(cfg.ddspEnv)];
        const free = await diskFree(cfg.probeDir);
        env = {
          msst: m.ok ? `py${m.version} cuda=${m.cuda}` : `不可用: ${m.error}`,
          ddsp: d.ok ? `py${d.version} cuda=${d.cuda} gpu=${d.gpu ?? '—'}` : `不可用: ${d.error}`,
          freeGB: free.ok ? Number(free.freeGB.toFixed(1)) : null,
        };
        lines.push('', `环境: MSST ${env.msst} ｜ DDSP ${env.ddsp} ｜ 磁盘 ${env.freeGB} GB 可用`);
      }
      // env 是可选字段：undefined 会让输出校验器判为非法 JSON，故只在有值时带上。
      const out = { dir, exists: scan.exists, entries: scan.entries, rendered: lines.join('\n') };
      if (env) out.env = env;
      return out;
    },
  });

  // ── 4 · S1/S2 分离 ────────────────────────────────────────────────────
  tools.register({
    name: 'cover_separate',
    description:
      'S1/S2 人声分离：MSST MelBandRoformer-kim 把歌曲拆成 vocals / instrumental；'
      + 'karaoke=true 时再对 vocals 做一次主唱/和声分离（决定"和声不换声"这一档）。'
      + '把要处理的 wav/mp3 放进一个**只含该文件**的输入目录。',
    parameters: {
      type: 'object',
      properties: {
        inputFolder: { type: 'string', description: '输入目录（只放要分离的音频）' },
        outDir: { type: 'string', description: '输出目录；结果落在 <outDir>/<曲名>/' },
        karaoke: { type: 'boolean', description: '是否追加主唱/和声分离（默认 true，保留原和声；false须明确选择整体换声）' },
        dryRun: { type: 'boolean', description: '只回显命令不执行' },
        timeoutMs: { type: 'integer' },
      },
      required: ['inputFolder', 'outDir'],
      additionalProperties: false,
    },
    output: textOut(stageSchemaWith({ karaokeResult: STAGE_SCHEMA }), (v) =>
      renderStage('人声分离', v) + (v.karaokeResult ? `\n\n${renderStage('主唱/和声分离', v.karaokeResult)}` : '')),
    execute: (args) => runSeparation(cfg, args),
  });

  // ── 5 · S3 伴奏/和声移调 ──────────────────────────────────────────────
  tools.register({
    name: 'cover_shift',
    description:
      'S3 把伴奏与和声按同一个 K 做整曲统一移调（pedalboard PitchShift，FLOAT 落盘避免硬削）。'
      + '★ 铁律：非八度 K 时**必须**做这一步，否则人声与伴奏相差 K 个半音 = 跑调；'
      + '八度 K（±12）保持调性，可以跳过这一步直接用原伴奏。',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'number', description: '半音数 K（与人声的 --uniform 相同）' },
        outDir: { type: 'string', description: '输出目录（生成 inst.wav / harm.wav）' },
        instSrc: { type: 'string', description: '源伴奏（★ 换歌必须指定）' },
        harmSrc: { type: 'string', description: '当前歌曲原和声（必须指定，禁止使用旧歌默认轨）' },
        subtype: { type: 'string', enum: ['FLOAT', 'PCM_24', 'PCM_16'], description: '落盘格式，默认 FLOAT' },
        dryRun: { type: 'boolean' },
        timeoutMs: { type: 'integer' },
      },
      required: ['key', 'outDir', 'instSrc', 'harmSrc'],
      additionalProperties: false,
    },
    output: textOut(STAGE_SCHEMA, (v) => renderStage('伴奏/和声移调', v)),
    execute: (args) => runStage(cfg, 'shift', args, { requires: [args.instSrc, args.harmSrc] }),
  });

  // ── 6 · S4 换声 ───────────────────────────────────────────────────────
  tools.register({
    name: 'cover_convert',
    description:
      'S4 换声推理（DDSP-SVC；默认原始batch，guided仅显式实验）：把源干声换成目标音色，整曲统一移调 K。'
      + '可用 voice 按名字选音色（如「祥子」），也可用 model 直指权重路径。'
      + '★ 先用 mode=pilot 试小段确认参数，再用 mode=full 跑整曲。'
      + 'k=0 表示源本身已在目标音区（如女声源），此时伴奏无需移调。',
    parameters: {
      type: 'object',
      properties: {
        src: { type: 'string', description: '源干声 wav' },
        key: { type: 'number', description: '整曲统一移调半音数（0 = 不移调）' },
        outDir: { type: 'string', description: '输出目录' },
        mode: { type: 'string', enum: ['pilot', 'full'], description: '默认 pilot；full须先取得同参数试听的用户确认' },
        backend: { type: 'string', enum: ['baseline', 'guided'], description: '默认 baseline：已验收batch路线；guided为未听审实验路线' },
        start: { type: 'number', description: 'pilot起点秒，默认0；已裁输入按本文件时间计' },
        duration: { type: 'number', description: 'pilot时长秒，默认25；短输入截至末尾，空窗失败' },
        step: { type: 'integer', description: '默认50' },
        voice: { type: 'string', description: '音色名（如「祥子」）；按名字从音色库解析，优先级低于 model' },
        method: { type: 'string', enum: ['euler', 'rk4'] },
        tStart: { type: 'number', description: '显式重建值0.7，不是原入口默认值' },
        amp: { type: 'number', description: '梳齿激励衰减（默认 0.5）' },
        nsfuv: { type: 'integer', description: 'NSF uv 帧置零（默认 1）' },
        confHi: { type: 'number' }, confLo: { type: 'number' }, nsfThred: { type: 'number' },
        crepeUv: { type: 'integer' }, crepeTh: { type: 'number' },
        model: { type: 'string', description: '模型绝对路径；省略时使用doctor检查的voiceModel' },
        dryRun: { type: 'boolean' },
        timeoutMs: { type: 'integer' },
      },
      required: ['src', 'key', 'outDir'],
      additionalProperties: false,
    },
    output: textOut(STAGE_SCHEMA, (v) =>
      renderStage('换声推理', v) + (v.artifacts?.some((a) => a.exists)
        ? `\n  下一步：将本次明确返回的主唱文件用于cover_mix，harm使用同源kara原和声；先对齐同一时间段，不能混用整曲轨。` : '')),
    execute(args) {
      let model = args.model;
      if (!model && args.voice) {
        const v = findVoice(cfg, args.voice);
        if (!v) {
          const names = cfg.voices.map((x) => `${x.name}(${x.steps}步)`).join(', ') || '（音色库为空）';
          return {
            ok: false, phase: 'precondition', label: '换声推理',
            error: `未找到音色 "${args.voice}"。可用: ${names}`,
            cmdline: '', artifacts: [], artifactsOk: false,
          };
        }
        model = v.model;
      }
      return runStage(cfg, 'convert', { ...args, model }, { requires: [args.src] });
    },
  });

  // ── 7 · S6 混音 ───────────────────────────────────────────────────────
  tools.register({
    name: 'cover_mix',
    description:
      'S6 混音 + 母带（pedalboard 全链：去浑浊 / 提清晰 / 去齿音 / 压缩 / 混响 / glue / 限幅 / LUFS 归一）。'
      + 'profile=standard 清晰度优先；lowband-safe 保住伴奏低频但**会顺手削掉人声清亮**'
      + '（它同时把 lead.presence_db 2.0→1.6、lead.mud_db −2.5→−1.5）。'
      + '可用 overrides 单独覆盖任意参数（如 ["lead.presence_db=2.0"]）把两个旋钮解耦。',
    parameters: {
      type: 'object',
      properties: {
        inst: { type: 'string' }, lead: { type: 'string' }, harm: { type: 'string' },
        out: { type: 'string', description: '输出母带 wav' },
        profile: { type: 'string', enum: ['standard', 'lowband-safe'] },
        overrides: { type: 'array', items: { type: 'string' }, description: '如 ["lead.presence_db=2.0"]' },
        targetLufs: { type: 'number', description: '默认 −14.0' },
        dryRun: { type: 'boolean' },
        timeoutMs: { type: 'integer' },
      },
      required: ['inst', 'lead', 'harm', 'out'],
      additionalProperties: false,
    },
    output: textOut(STAGE_SCHEMA, (v) => renderStage('混音 + 母带', v)),
    execute: (args) => runStage(cfg, 'mix', args, { requires: [args.inst, args.lead, args.harm] }),
  });

  // ── 8 · S7 验收 ───────────────────────────────────────────────────────
  tools.register({
    name: 'cover_verify',
    description:
      'S7 五门验收：整合响度（−14.0±0.5 LUFS）、真峰值（≤−1.0 dBTP）、波峰因数（≥12 dB）、'
      + '动态范围 LRA、立体声相关（0.20~0.95）。返回 PASS/FAIL 明细，可同时落盘 JSON。'
      + '★ ok仅代表技术门结果；用户听感验收单独记录，不由数值替代。',
    parameters: {
      type: 'object',
      properties: {
        wav: { type: 'string', description: '待验收的 wav' },
        ref: { type: 'string', description: '参考版本 wav（可选，做对照）' },
        json: { type: 'string', description: '结果 JSON 落盘路径（可选）' },
        targetLufs: { type: 'number' },
        dryRun: { type: 'boolean' },
        timeoutMs: { type: 'integer' },
      },
      required: ['wav'],
      additionalProperties: false,
    },
    output: textOut(STAGE_SCHEMA, (v) => renderStage('五门验收', v)),
    execute: (args) => runStage(cfg, 'verify', args, { requires: [args.wav] }),
  });

  // ── 9 · 质检（一个工具五个变体）──────────────────────────────────────
  tools.register({
    name: 'cover_qc',
    description:
      '可选诊断套件（非默认完成条件），按 kind 选择：'
      + 'crack=破音扫描（逐帧 vs 自身 ±0.5 s 邻域的 z 分数离群，用 lead/ref/a/b）；'
      + 'conv=换声有效性（MFCC 距离 + 时长/F0 是否被动过）；'
      + 'section=逐段频谱画像（不判断音色身份，用 win 指定窗口）；'
      + 'bright=清亮画像（DIN 45692 尖锐度，需 mosqito）；'
      + 'source=候选源音区调查（按模型和试听判断，不使用通用音域阈值）。',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['crack', 'conv', 'section', 'bright', 'source'] },
        lead: { type: 'string', description: 'crack/conv/section 用' },
        ref: { type: 'string', description: 'crack/conv/section 用（参考干声）' },
        a: { type: 'number', description: 'crack 起始秒' },
        b: { type: 'number', description: 'crack 结束秒' },
        win: { type: 'array', items: { type: 'string' }, description: '形如 ["名:t0:t1"]' },
        file: { type: 'array', items: { type: 'string' }, description: 'bright 用，形如 ["名=路径"]' },
        lufs: { type: 'number', description: 'bright 的等响目标，默认 −20' },
        files: { type: 'array', items: { type: 'string' }, description: 'source 用，干声 wav 列表' },
        dryRun: { type: 'boolean' },
        timeoutMs: { type: 'integer' },
      },
      required: ['kind'],
      additionalProperties: false,
    },
    output: textOut(stageSchemaWith({ kind: { type: 'string' } }), (v) => renderStage(`质检·${v.kind ?? ''}`, v)),
    async execute(args) {
      const map = { crack: 'qcCrack', conv: 'qcConv', section: 'qcSection', bright: 'qcBright', source: 'qcSource' };
      const key = map[args.kind];
      const req = [];
      if (args.lead) req.push(args.lead);
      if (args.ref) req.push(args.ref);
      if (Array.isArray(args.files)) req.push(...args.files);
      const r = await runStage(cfg, key, args, { requires: req });
      return { ...r, kind: args.kind };
    },
  });

  // ── 10 · S8 裁剪 ──────────────────────────────────────────────────────
  tools.register({
    name: 'cover_cut',
    description:
      'S8 裁剪：把成品裁成只保留指定段落（如副歌），切口自动吸附到标称边界附近的**短时能量极小点**，'
      + '首尾加淡入淡出，裁后重新归一到目标响度，并回传接缝样点跳变以自证没有引入咔哒。'
      + '★ 裁剪常能消掉"伴奏移调"的必要性——副歌本身的音区往往已在目标窗口内。',
    parameters: {
      type: 'object',
      properties: {
        src: { type: 'string' }, out: { type: 'string' },
        segs: { type: 'string', description: '形如 "46.27:69.00,107.85:128.47"' },
        snap: { type: 'number', description: '边界吸附半径秒，默认 0.6；0 表示不吸附' },
        fade: { type: 'number' }, gap: { type: 'number' },
        targetLufs: { type: 'number' },
        noNormalize: { type: 'boolean' },
        dryRun: { type: 'boolean' },
        timeoutMs: { type: 'integer' },
      },
      required: ['src', 'out', 'segs'],
      additionalProperties: false,
    },
    output: textOut(STAGE_SCHEMA, (v) => renderStage('副歌裁剪', v)),
    execute: (args) => runStage(cfg, 'cut', args, { requires: [args.src] }),
  });

  // ── 11 · S9 发布 ──────────────────────────────────────────────────────
  tools.register({
    name: 'cover_release',
    description:
      '可选本地封装：wav → mp3 320k（lameenc）+ ID3v2.3（mutagen）+ ID3v1（手工 128 字节尾块），'
      + '并**自证**解码后的响度/真峰值/时长差与标签回读，而不是跑完就算。'
      + '★ 会提示版权：AI 翻唱的词曲著作权仍属原作者，建议仅作个人试听。',
    parameters: {
      type: 'object',
      properties: {
        wav: { type: 'string' }, outDir: { type: 'string' },
        name: { type: 'string', description: '输出基础名（不含扩展名）' },
        title: { type: 'string' }, artist: { type: 'string' },
        album: { type: 'string' }, year: { type: 'string' },
        genre: { type: 'string' }, track: { type: 'string' }, comment: { type: 'string' },
        bitrate: { type: 'integer', description: '默认 320' },
        dryRun: { type: 'boolean' },
        timeoutMs: { type: 'integer' },
      },
      required: ['wav', 'outDir', 'name', 'title', 'artist'],
      additionalProperties: false,
    },
    output: textOut(STAGE_SCHEMA, (v) =>
      renderStage('发布封装', v)
      + '\n  ⚠️ 版权提示：AI 翻唱的**词曲著作权仍属原作者与权利人**，建议仅作个人试听/技术验证，不用于商业发布或二次分发。'),
    execute: (args) => runStage(cfg, 'release', args, { requires: [args.wav] }),
  });

  registered.push(
    'cover_doctor', 'cover_setup', 'cover_plan', 'cover_status', 'cover_separate', 'cover_shift',
    'cover_convert', 'cover_mix', 'cover_verify', 'cover_qc', 'cover_cut', 'cover_release',
  );
  logger.info(`[cover-pipeline] 已注册 ${registered.length} 个工具: ${registered.join(', ')}`);
  logger.info(`[cover-pipeline] 工程根=${cfg.pipelineRoot}  MSST=${cfg.msstEnv}  DDSP=${cfg.ddspEnv}`);
}
