/**
 * 环境探测（doctor）。
 *
 * 设计要点：
 *   1. **一次 Python 调用拿回全部信息**（版本 / 可导入模块 / torch / CUDA / GPU），
 *      而不是每个模块 spawn 一次 —— 每次 spawn Windows 上要 100~300 ms。
 *   2. 每条检查都带 **fix**（怎么修），而不是只说"缺了"。
 *   3. 分 level：`error` 缺了就跑不动；`warn` 缺了会降级；`info` 仅记录。
 */
import { existsSync, statSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { run, runPythonCode, runFfmpeg } from './runner.js';
import { DDSP_ASSETS, MSST_ASSETS, SCRIPTS, join } from './config.js';

const PY_PROBE = `
import json, sys, importlib.util as u
mods = ['numpy','scipy','soundfile','librosa','pyloudnorm','pedalboard','torch','torchcrepe','mosqito','mutagen','lameenc']
out = {'version': sys.version.split()[0], 'exe': sys.executable,
       'modules': {m: bool(u.find_spec(m)) for m in mods}}
try:
    import torch
    out['torch'] = torch.__version__
    out['cuda'] = bool(torch.cuda.is_available())
    out['gpu'] = torch.cuda.get_device_name(0) if torch.cuda.is_available() else None
except Exception as e:
    out['torch'] = None; out['cuda'] = False; out['gpu'] = None
print(json.dumps(out, ensure_ascii=False))
`;

function fileRow(name, p, { level = 'error', minBytes = 1, fix = '' } = {}) {
  if (!p) return { name, level, ok: false, detail: '未配置路径', fix };
  if (!existsSync(p)) return { name, level, ok: false, detail: `不存在: ${p}`, fix };
  const st = statSync(p);
  const ok = st.size >= minBytes;
  return {
    name, level, ok,
    detail: `${(st.size / 1048576).toFixed(1)} MB  ${p}`,
    fix: ok ? '' : `文件过小（${st.size} B），疑似下载/复制未完成`,
  };
}

export async function probePython(envPath) {
  const r = await runPythonCode(envPath, PY_PROBE, { timeoutMs: 120_000 });
  if (!r.ok) return { ok: false, raw: r, error: r.stderr || `exit=${r.code}` };
  try {
    const line = r.stdout.trim().split('\n').filter(Boolean).pop();
    return { ok: true, ...JSON.parse(line) };
  } catch (err) {
    return { ok: false, raw: r, error: `探测输出无法解析: ${String(err)}` };
  }
}

export async function diskFree(p) {
  try {
    // 取盘符根（Windows）或存在的最近祖先
    let probe = p;
    while (probe && !existsSync(probe)) {
      const next = probe.replace(/[\\/][^\\/]*$/, '');
      if (next === probe) break;
      probe = next;
    }
    const st = await statfs(probe || '.');
    const freeBytes = Number(st.bsize) * Number(st.bavail);
    return { ok: true, freeGB: freeBytes / 1073741824, path: probe };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/** 完整体检。返回 {ok, errors, warnings, checks[]} */
export async function doctor(cfg) {
  const checks = [];

  checks.push({
    name: 'Node 运行时', level: 'error', ok: true,
    detail: `${process.version}  ${process.execPath}`, fix: '',
  });

  // ── 目录 ────────────────────────────────────────────────────────────
  for (const [name, p] of [
    ['工程根 pipelineRoot', cfg.pipelineRoot],
    ['脚本目录 probeDir', cfg.probeDir],
    ['混音工程 mixDir', cfg.mixDir],
    ['MSST 目录 msstDir', cfg.msstDir],
    ['DDSP 目录 ddspDir', cfg.ddspDir],
  ]) {
    checks.push({
      name, level: 'error', ok: existsSync(p),
      detail: existsSync(p) ? p : `不存在: ${p}`,
      fix: existsSync(p) ? '' : '检查 cordis.patch.yml 里的路径配置',
    });
  }

  // ── 两套 Python ─────────────────────────────────────────────────────
  const need = {
    msst: { mods: ['numpy', 'scipy', 'soundfile', 'librosa', 'pyloudnorm', 'pedalboard'], label: 'MSST' },
    ddsp: { mods: ['numpy', 'scipy', 'soundfile', 'torch', 'torchcrepe'], label: 'DDSP' },
  };
  for (const [key, envPath] of [['msst', cfg.msstEnv], ['ddsp', cfg.ddspEnv]]) {
    const spec = need[key];
    if (!existsSync(envPath)) {
      checks.push({
        name: `Python 环境 · ${spec.label}`, level: 'error', ok: false,
        detail: `解释器不存在: ${envPath}`,
        fix: '见 README「环境配置」——两套 env 是硬依赖，且不能用同一个',
      });
      continue;
    }
    const pr = await probePython(envPath);
    if (!pr.ok) {
      checks.push({
        name: `Python 环境 · ${spec.label}`, level: 'error', ok: false,
        detail: `探测失败: ${pr.error}`,
        fix: '手动跑一次该 python.exe 看是否可启动',
      });
      continue;
    }
    const missing = spec.mods.filter((m) => !pr.modules?.[m]);
    checks.push({
      name: `Python 环境 · ${spec.label}`, level: 'error', ok: missing.length === 0,
      detail: `py${pr.version}  torch=${pr.torch ?? '—'}  cuda=${pr.cuda}`
        + (pr.gpu ? `  GPU=${pr.gpu}` : '')
        + (missing.length ? `  ★缺模块: ${missing.join(',')}` : ''),
      fix: missing.length
        ? `用该 env 的 pip 安装: ${missing.join(' ')}（注意 DDSP env 是共享 torch 底座，别乱装）`
        : '',
    });
  }

  // ── 模型权重 ────────────────────────────────────────────────────────
  checks.push(fileRow('HiFiGAN 声码器', join(cfg.ddspDir, DDSP_ASSETS.hifigan),
    { minBytes: 10e6, fix: 'DDSP 的 pretrain 缺失，需重新获取' }));
  checks.push(fileRow('ContentVec 编码器', join(cfg.ddspDir, DDSP_ASSETS.contentvec),
    { minBytes: 10e6, fix: 'DDSP 的 pretrain 缺失，需重新获取' }));
  checks.push(fileRow('目标音色模型 voiceModel', cfg.voiceModel,
    { minBytes: 10e6, fix: '把音色模型的 exp/ 复制到 ddspDir（见模型包内说明）' }));
  checks.push(fileRow('MSST 人声权重', join(cfg.msstDir, MSST_ASSETS.vocalModel),
    { minBytes: 10e6, fix: 'MSST 的 pretrain 缺失' }));
  checks.push(fileRow('MSST 卡啦权重', join(cfg.msstDir, MSST_ASSETS.karaModel),
    { minBytes: 1e6, level: 'warn', fix: '缺它则无法做「和声不换声」D 档，会降级为整体换声' }));

  // ── 外部工具 ────────────────────────────────────────────────────────
  checks.push(fileRow('ffmpeg', cfg.ffmpeg, {
    minBytes: 1e6, level: 'warn',
    fix: '★ 本机系统 ffmpeg 是阉割版；这里指的是 MSST env 里那份完整 ffmpeg',
  }));
  if (existsSync(cfg.ffmpeg)) {
    const r = await runFfmpeg(cfg, ['-version'], { timeoutMs: 30_000 });
    const first = (r.stdout || r.stderr).split('\n')[0] || '';
    checks.push({
      name: 'ffmpeg 可用', level: 'warn', ok: first.includes('ffmpeg version'),
      detail: first.slice(0, 120), fix: first.includes('ffmpeg version') ? '' : '执行 ffmpeg -version 失败',
    });
  }

  // ── 音质库（可选，缺了会降级）──────────────────────────────────────
  const qlib = cfg.qualityLibDir;
  if (existsSync(qlib)) {
    for (const pkg of ['mosqito', 'lameenc', 'mutagen']) {
      const p = join(qlib, pkg);
      checks.push({
        name: `音质库 ${pkg}`, level: 'info', ok: existsSync(p),
        // ★ 这些是 pip --target 装出来的**目录**，不能用文件大小判定
        detail: existsSync(p) ? `已就位（${p}）` : `未安装（${p}）`,
        fix: '',
      });
    }
  } else {
    checks.push({
      name: '音质库目录', level: 'warn', ok: false, detail: `不存在: ${qlib}`,
      fix: 'pip install mosqito mutagen --no-deps --target <该目录>；缺了则 p95/p97 降级（不影响出成品）',
    });
  }

  // ── 流水线脚本 ──────────────────────────────────────────────────────
  const missingScripts = Object.entries(SCRIPTS)
    .filter(([, f]) => !existsSync(join(cfg.probeDir, f)))
    .map(([k, f]) => `${k}(${f})`);
  checks.push({
    name: `流水线脚本（${Object.keys(SCRIPTS).length} 个）`, level: 'error',
    ok: missingScripts.length === 0,
    detail: missingScripts.length ? `缺 ${missingScripts.length} 个: ${missingScripts.join(', ')}` : '全部就位',
    fix: missingScripts.length ? '这些脚本是本项目自研的，需随工程一起拷贝到 probeDir' : '',
  });

  // ── 磁盘 ────────────────────────────────────────────────────────────
  const d = await diskFree(cfg.probeDir);
  checks.push({
    name: '磁盘可用空间', level: 'warn',
    ok: d.ok && d.freeGB >= 10,
    detail: d.ok ? `${d.freeGB.toFixed(1)} GB 可用（${d.path}）` : String(d.error),
    fix: d.ok && d.freeGB < 10 ? '一次完整流水线约需 3–6 GB（分离+换声+混音中间件）' : '',
  });

  // ── 代理（只在需要联网取源时才用）──────────────────────────────────
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
  checks.push({
    name: '网络代理（取源用）', level: 'info', ok: true,
    detail: proxy || '未设置（仅影响从 B站/网易云取素材，不影响出成品）', fix: '',
  });

  const errors = checks.filter((c) => !c.ok && c.level === 'error');
  const warnings = checks.filter((c) => !c.ok && c.level === 'warn');
  return { ok: errors.length === 0, errors, warnings, checks };
}

/** 把 doctor 结果渲染成人读文本 */
export function renderDoctor(res) {
  const icon = (c) => (c.ok ? '✅' : c.level === 'error' ? '❌' : c.level === 'warn' ? '⚠️' : 'ℹ️');
  const lines = res.checks.map((c) => `${icon(c)} ${c.name}——${c.detail}${c.fix ? `\n     修: ${c.fix}` : ''}`);
  const head = res.ok
    ? `环境体检通过（${res.checks.length} 项，${res.warnings.length} 条警告）`
    : `环境体检失败：${res.errors.length} 项阻塞、${res.warnings.length} 条警告`;
  return `${head}\n\n${lines.join('\n')}`;
}
