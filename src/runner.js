/**
 * 子进程执行器。
 *
 * ★ 为什么用 Node spawn + **参数数组**（而不是 shell 字符串）：
 *   1. 完全绕开引号转义 —— 路径里的空格、括号、中文都不需要处理；
 *   2. **中文参数不会被破坏**（本项目在 PowerShell 里反复踩过 GBK/UTF-8 坑，
 *      Node 的 argv 是 UTF-16 → 系统调用直传，不经 shell 编码转换）；
 *   3. 不需要 PowerShell，也就没有 ExecutionPolicy / here-string 那些问题。
 *
 * 输出统一 UTF-8 解码；超时则 kill 并回传**已获得的部分输出**（不是丢弃）。
 */
import { spawn } from 'node:child_process';

const isWin = process.platform === 'win32';

/** 截断长输出，保留头部与尾部（中间省略），便于人读又保住关键信息 */
export function truncate(text, max) {
  const s = String(text ?? '');
  if (!max || s.length <= max) return s;
  const head = Math.floor(max * 0.65);
  const tail = max - head;
  return `${s.slice(0, head)}\n…（省略 ${s.length - max} 字符）…\n${s.slice(-tail)}`;
}

/**
 * 运行一个外部命令。
 * @param {string} cmd 可执行文件绝对路径
 * @param {string[]} args 参数数组（原样传递，不做 shell 解析）
 * @param {{cwd?:string, timeoutMs?:number, env?:object, maxOutputChars?:number}} [opts]
 * @returns {Promise<{ok:boolean, code:number|null, signal:string|null, stdout:string,
 *                    stderr:string, ms:number, timedOut:boolean, cmdline:string}>}
 */
export function run(cmd, args = [], opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 3_600_000;
  const maxOut = opts.maxOutputChars ?? 6000;
  const started = Date.now();
  const cmdline = [cmd, ...args].map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ');

  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.env ?? {}), PYTHONIOENCODING: 'utf-8' },
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolvePromise({
        ok: false, code: null, signal: null, stdout: '', stderr: String(err),
        ms: Date.now() - started, timedOut: false, cmdline,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(isWin ? undefined : 'SIGKILL'); } catch { /* ignore */ }
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });

    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        ok: !timedOut && code === 0,
        code,
        signal: signal ?? null,
        stdout: truncate(stdout, maxOut),
        stderr: truncate(stderr, maxOut),
        ms: Date.now() - started,
        timedOut,
        cmdline,
      });
    };

    child.on('error', (err) => {
      stderr += `\n[spawn error] ${err.message}`;
      finish(null, null);
    });
    child.on('close', finish);
  });
}

/** 运行 Python 脚本：<env> <script> <args...> */
export function runScript(cfg, envPath, cwd, scriptAbs, args = [], opts = {}) {
  return run(envPath, [scriptAbs, ...args], {
    cwd,
    timeoutMs: opts.timeoutMs ?? cfg.timeoutMs,
    maxOutputChars: opts.maxOutputChars ?? cfg.maxOutputChars,
  });
}

/** 运行一段 Python 代码（-c），用于环境探测等短任务 */
export function runPythonCode(envPath, code, opts = {}) {
  return run(envPath, ['-c', code], {
    timeoutMs: opts.timeoutMs ?? 120_000,
    maxOutputChars: opts.maxOutputChars ?? 4000,
  });
}

export function runFfmpeg(cfg, args, opts = {}) {
  return run(cfg.ffmpeg, args, {
    timeoutMs: opts.timeoutMs ?? 600_000,
    maxOutputChars: opts.maxOutputChars ?? 4000,
  });
}
