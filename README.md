# dsh-cover-pipeline —— 自然语言驱动的 AI 翻唱全流程（DSH 插件）

**安装前先读：[依赖清单与上游下载入口](docs/dependencies.md)** — 按已审计路线区分必需组件、条件可选项、旧版 ContentVec 兼容性和外置混音源码缺口。该页独立记录 1.1.2 工作版本审计，不代表相关实现 PR 已合并或发布新版本；以下历史使用说明请结合该页的版本边界阅读。

> 把「分离 → 换声 → 移调 → 混音 → 验收 → 裁剪 → 发布」整条链，做成 DSH 里可直接调用的 11 个工具。
> **零运行时依赖**（只用 `node:` 内置模块）；重活全部交给两套既有 Python 环境。

---

## 0 · 一句话

在 DSH 里说「**把这首歌做成 XX 音色的翻唱**」，模型会：
`cover_doctor`（验环境）→ `cover_plan`（出计划 + 该问你的问题）→ `cover_separate` → `cover_convert` → `cover_shift` → `cover_mix` → `cover_verify` → （可选）`cover_qc`/`cover_cut` → `cover_release`。

**插件不替模型猜参数** —— 它把「哪些必须量、量什么、判据是什么」编码进 `cover_plan` 的返回里。

---

## 1 · 工具清单

| 工具 | 阶段 | 作用 |
|---|---|---|
| `cover_doctor` | S0 | **环境体检**（12+ 项，每项带修复办法） |
| `cover_plan` | S0 | 自然语言 → 九段流程 + 五个决策点 + 验收门 + **待确认问题** |
| `cover_status` | — | 勘探工程目录（已有哪些中间件，避免重复生成） |
| `cover_separate` | S1/S2 | 人声分离（MSST kim）± 主唱/和声分离 |
| `cover_shift` | S5 | 伴奏+和声整曲统一移调（非八度 K 必做） |
| `cover_convert` | S4 | 换声推理（引导式参数，整曲统一 K） |
| `cover_mix` | S6 | 混音 + 母带（standard / lowband-safe / 任意参数覆盖） |
| `cover_verify` | S7 | **五门验收** |
| `cover_qc` | S3/S8 | 质检五变体：`crack` / `conv` / `section` / `bright` / `source` |
| `cover_cut` | S8 | 裁剪（能量极小切口 + 淡入淡出 + 重定响度 + 接缝自证） |
| `cover_release` | S9 | mp3 320k + ID3v2.3 + ID3v1（**自证**解码指标与标签回读） |

---

## 2 · ★ 需要配置的环境

### 2.1 总览（缺哪件会怎样）

| # | 组件 | 本机位置 | 谁在用 | 缺了会怎样 |
|---|---|---|---|---|
| 1 | **Node** | DSH 自带（Electron 以 `ELECTRON_RUN_AS_NODE` 跑） | 插件本体 | — 插件跑不起来 |
| 2 | **MSST Python env** | `D:\AI-Song\01_人声分离_MSST-GUI\env\python.exe` | 分离 / 移调 / 混音 / 验收 / 裁剪 / 发布 / 全部 QC | **阻塞** |
| 3 | **DDSP Python env** | `D:\AI-Song\02_模型推理_DDSP-SVC-6.2\DDSP-barbara-6.2\env\python.exe` | 换声推理 | **阻塞** |
| 4 | MSST 分离权重 ×2 | `…\MSST-GUI\pretrain\MelBandRoformer_kim.ckpt`（人声）<br>`…\pretrain\bs_roformer_karaoke_frazer_becruily.ckpt`（和声） | S1/S2 | 人声权重缺=阻塞；卡啦权重缺=降级 |
| 5 | HiFiGAN 声码器 | `…\DDSP-barbara-6.2\pretrain\pc_nsf_hifigan_44.1k_hop512_128bin_2025.02\model.ckpt` | S4 | **阻塞** |
| 6 | ContentVec 编码器 | `…\DDSP-barbara-6.2\pretrain\contentvec\checkpoint_best_legacy_500.pt` | S4 | **阻塞** |
| 7 | **目标音色模型** | `D:\AI-Song\03_音色模型_MYGO-AveMujica\祥子_步数20000\exp\reflow-test\model_20000.pt` | S4 | **阻塞** |
| 8 | 完整 ffmpeg | `…\MSST-GUI\env\ffmpeg.exe`（141 MB） | 取源转码 | 取源失败（★ **不要用系统那个阉割版**） |
| 9 | 音质库 mosqito / mutagen | `…\_pipeline_bqll\_probe\_sq` | `qc(bright)` / `release` | **降级**（不影响出成品） |
| 10 | 15 个流水线脚本 | `…\_pipeline_bqll\_probe\p5x_*.py / p9x_*.py` | 全部阶段 | **阻塞**（自研脚本，需随工程拷贝） |
| 11 | GPU（CUDA） | RTX 5060 Laptop / torch 2.8.0+cu128 | S1/S4 | 慢 10–30 倍（可 CPU 跑） |
| 12 | 磁盘 ≥10 GB | D 盘 | 全程 | 中间件写不下（一次全流程约 3–6 GB） |
| 13 | 网络代理（可选） | `HTTPS_PROXY=http://127.0.0.1:7890` | **仅在从 B站/网易云取素材时** | 不影响出成品 |

### 2.2 两套 Python 环境（**为什么必须是两套**）

它们**不能合并**，因为依赖互相冲突且各自体量很大：

| | MSST env | DDSP env |
|---|---|---|
| Python | 3.10.18 | 3.10.18 |
| 必需包 | `numpy` `scipy` `soundfile` `librosa` **`pyloudnorm`** **`pedalboard`** `torch` | `numpy` `scipy` `soundfile` `librosa` `torch` **`torchcrepe`** |
| 不需要 | torchcrepe（可用） | **`pyloudnorm` / `pedalboard`** |
| 职责 | 分离 · 移调 · 混音 · 验收 · 裁剪 · 发布 · QC | 换声推理（DDSP-SVC） |

> ★ **DDSP env 是全机共享的 torch 底座**（`D:\AI-Voice` 的 venv 也挂在它上面）——
> 不要删、不要挪、不要在它里面随意升级 torch。
> ★ 两个 env 都是 **Python 3.10**：换 3.11+ 会有包不兼容风险。

**建环境的最小命令**（若在新机器上重建）：

```powershell
# MSST env
python -m venv D:\AI-Song\01_人声分离_MSST-GUI\env
& D:\AI-Song\01_人声分离_MSST-GUI\env\Scripts\python.exe -m pip install `
    numpy scipy soundfile librosa pyloudnorm pedalboard `
    torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu128

# DDSP env（torch 要带 CUDA；其余按 DDSP-SVC 6.2 的 requirements）
python -m venv D:\AI-Song\02_模型推理_DDSP-SVC-6.2\DDSP-barbara-6.2\env
& ...\env\Scripts\python.exe -m pip install numpy scipy soundfile librosa torchcrepe
& ...\env\Scripts\python.exe -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu128
```

**音质库（可选，装到独立目录、不动任何 env）**：

```powershell
& D:\AI-Song\01_人声分离_MSST-GUI\env\python.exe -m pip install mosqito mutagen `
    --no-deps --target D:\AI-Song\_pipeline_bqll\_probe\_sq `
    -i https://mirrors.cloud.tencent.com/pypi/simple
# 注意：mosqito 有个硬依赖 pyuff，也要一起装（同样 --no-deps --target）
& ...\python.exe -m pip install pyuff --no-deps --target ...\_sq
```
> 脚本用 `sys.path.insert(0, '_sq')` 加载它们，所以**不会污染** env。
> mosqito 提供 DIN 45692 尖锐度（"清亮"的客观对应量）；mutagen 用于写 ID3。

### 2.3 目标音色模型怎么放

DDSP-SVC 只认 `<ddspDir>/exp/<实验名>/` 与 `pretrain/`。音色模型包（如 `祥子_步数20000`）解压后：

```
把  03_音色模型_MYGO-AveMujica\祥子_步数20000\exp\reflow-test\
放到 02_模型推理_DDSP-SVC-6.2\DDSP-barbara-6.2\exp\reflow-test\
```
（模型包内自带的 `1.删除或改名根目录原exp文件.txt` / `2.复制到DDSP根目录.txt` 说的就是这件事。）
`model_20000.pt` 约 **267 MB**；`cover_doctor` 会校验它在不在、够不够大。

### 2.4 ffmpeg：为什么指定 env 里那一份

- 系统 `ffmpeg` 是**阉割版**（无 ffprobe / 无 wav muxer）；
- MSST env 里的 `ffmpeg.exe`（141 MB）是完整的，取源转码走它。

### 2.5 配置项（`config`）

全部键都有内置默认值（对准本机布局），可在 `cordis.patch.yml` / `cordis.dev.yml` 覆盖：

| 键 | 默认 | 说明 |
|---|---|---|
| `songRoot` | `D:/AI-Song` | 机器级资产根 |
| `pipelineRoot` | `…/_pipeline_bqll` | 工程根（`00_src/01_sep/02_conv/03_mix`） |
| `probeDir` | `…/_probe` | **脚本与产物目录** |
| `mixDir` | `D:/AI-Song/_pipeline_mingyue` | `mix_master.py` / `verify_mix.py` 所在 |
| `msstDir` / `msstEnv` | 见上表 | MSST 工作目录（★ 必须设，`inference.py` 用相对 config 路径）/ 解释器 |
| `ddspDir` / `ddspEnv` | 见上表 | 同上 |
| `ffmpeg` | MSST env 里的 | |
| `voiceModel` | 祥子 20000 步 | 仅用于 doctor 校验存在性 |
| `qualityLibDir` | `…/_probe/_sq` | mosqito/mutagen 独立安装目录 |
| `targetLufs` | `-14.0` | 交付响度标准 |
| `timeoutMs` | `3600000` | 单阶段超时（换声整曲约 4 分钟，留足余量） |
| `maxOutputChars` | `6000` | 回传给模型的日志上限（首尾保留） |

环境变量（优先级低于 config，但便于换机器）：`DSH_COVER_ROOT` / `DSH_COVER_PROBE`。

---

## 3 · 安装与生效

### 方式 A · 临时试用（**零改动，推荐先走这条**）

```powershell
& 'D:\DSH\resources\runtime\cli\bin\dsh.cmd' web --patch 'D:\AI-Song\dsh-plugin-cover\cordis.dev.yml'
```

`--patch` 的语义（`dsh --help` 原文）：*"extra patch-list overlay applied after the profile layer (repeatable)"* ——
**不写任何 profile 文件**，只在这一次启动里叠加。

**生效前可只读验证**（不挂载）：

```powershell
& 'D:\DSH\resources\runtime\cli\bin\dsh.cmd' web --patch 'D:\AI-Song\dsh-plugin-cover\cordis.dev.yml' --dump-config |
    Select-String 'cover-pipeline'
```

### 方式 B · 长期安装（写进 profile）

```powershell
& 'D:\DSH\resources\runtime\cli\bin\dsh.cmd' plugin --profile <profile> add 'D:\AI-Song\dsh-plugin-cover'
```
`dsh plugin --profile <name> <pnpm-args...>` 是 DSH 官方给的插件安装入口（README 里的 `add <package>` 也支持**本地路径**）。
装完 `package.json` 的 `dsh.profile.bundles` 会自动多一项，本包自带的 `cordis.patch.yml` 会在启动时自动加载。

### ⚠️ 关于桌面 GUI（`desktop` profile）

本机 CLI 明确拒绝操作 `desktop`：
```
$ dsh --profile desktop --dump-config
error: profile "desktop" is managed exclusively by the Electron application
```
⇒ **桌面版要走 GUI 自带的插件管理**（DSH 内置 `@deepseek-ai/dsh-plugin-manager`，QQBot profile 里能看到它的 `.plugin-manager` 日志），
或把插件装到自建 profile 后用 CLI 启动。

> **本鱼没有改动你的任何 profile** —— 这属于改你的持久配置，需你点头。

### 不重启也能自检（开发用）

```powershell
node D:\AI-Song\dsh-plugin-cover\test\harness.mjs
```
它用 mock ctx 把插件加载起来，校验**导出契约 / 工具定义形状 / JSON Schema 健全性 / 输出契约 / 真机 doctor**，
并对 8 个阶段工具做 dry-run 回显命令行。退出码 0 = 全绿。

---

## 4 · 快速开始（模型视角）

```
1) cover_doctor                     → 看环境能不能跑
2) cover_plan {request:"…"}         → 拿到流程 + **该问用户的 5 个问题**（先问，再动手）
3) cover_separate {inputFolder, outDir, karaoke:true}
4) cover_qc {kind:"source", files:[…vocals.wav]}     → 量音区（D1）
5) cover_convert {src, key, outDir}                  → 先 mode:"pilot" 再 "full"
6) cover_shift {key, outDir, instSrc}                → ★ 非八度 K 必做
7) cover_mix {inst, lead, harm, out}
8) cover_verify {wav, json}                          → 五门全过才算完成态
9) cover_qc {kind:"crack", …} + 按需 cover_cut / cover_release
```

★ **移调铁律**：`key` 必须**同时**用在 `cover_convert` 与 `cover_shift` 上；
若 `key=0`（源本身已在目标音区）或 `key=±12`（八度保调性），可跳过 `cover_shift`。

---

## 5 · 迁移到新机器的清单

1. 装 DSH（`D:\DSH`），确认 `D:\DSH\resources\runtime\cli\bin\dsh.cmd` 存在。
2. 复制 `D:\AI-Song\` 的这几块：`01_人声分离_MSST-GUI`、`02_模型推理_DDSP-SVC-6.2`、`03_音色模型_*`、`_pipeline_bqll`、`_pipeline_mingyue`。
3. 目标音色模型按 §2.3 放进 `exp/reflow-test/`。
4. 装可选音质库（§2.2 末尾）。
5. 把本插件目录拷过去，按需改 `cordis.dev.yml` 里的路径（或设 `DSH_COVER_ROOT`）。
6. 跑 `node test/harness.mjs` → 再跑 `cover_doctor`，全绿即就绪。

> 路径与体积明细见交付包 `手册与依赖\AI翻唱-依赖项路径清单.md`。

---

## 6 · 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| `tools 服务不可用` | 插件 `inject:['tools']` 未满足 | 确认 profile 里有 `- id: tools / @deepseek-ai/dsh-tools` 行 |
| `inference.py` 报找不到 config | 没在 `msstDir` 下运行 | 插件已固定 `cwd: msstDir`；若手动跑要注意 |
| 换声报 `f0=[65,800]` 越界 | K 太大把音区推出模型范围 | 降 K；★ 注意 `f0_max` 只限**提取**、不限**合成**，hook 高音仍能合成 |
| 伴奏变薄 | 非八度移调吃了低频 | 量 `qcSrcProfile` 同段对照；或改用**八度 K**（零移调）/ 裁剪掉低音区 |
| 人声变闷 | 用了 `lowband-safe` 档 | 该档把 `lead.presence_db` 2.0→1.6、`mud_db` −2.5→−1.5；用 `overrides` 解耦 |
| 成品听着"假" | 缺少空间统一 | 混音链默认带并联混响；若 `--no-reverb` 会变干 |
| mp3 比 wav 响/尖 | 编码过冲 | `cover_release` 会回读真峰值并报告；本流程母带留 −2.6 dBTP 余量 |

---

## 7 · 已知边界（**别当成缺陷**）

1. **"唱法/断句/气口合不合适"我量不了。** 换声只换音色，唱法完全继承源。这类判断只能交给人耳，
   且应当在跑推理**之前**听源干声决定 —— 插件的 `cover_plan` 会把它列进"待确认问题"。
2. **非八度移调必然伤伴奏低频**（实测 +8 时 sub 41.4%→5.1%）。要么接受，要么用八度 K，要么裁剪。
3. **频段占比不能跨段比较**（占比恒为 100%，加低频必然压低其他段）。质检一律要求**同段对照**。
4. **AI 翻唱的版权**：词曲著作权仍属原作者与权利人 ⇒ 建议仅作个人试听/技术验证。

---

## 8 · 目录结构

```
dsh-plugin-cover\
├─ package.json         # dsh.bundle.patch 指向下面的 patch；type:module
├─ cordis.patch.yml     # 随包分发：- insert: [ cover-pipeline 行 ]（长期安装）
├─ cordis.dev.yml       # --patch 用：name 为 file:// 绝对路径（零改动试用）
├─ LICENSE              # MIT（★ 不含也不授予任何模型权重/音色模型的授权）
├─ .gitattributes       # ★ `* -text`：禁止 CRLF↔LF 自动转换（会静默破坏 sha256 自证）
├─ src\
│  ├─ index.js          # 插件主体：11 个工具 + 阶段执行内核 + 产物自证
│  ├─ config.js         # 默认值/归一化/脚本索引
│  ├─ runner.js         # 子进程执行（spawn + 参数数组 ⇒ 中文与空格全免疫）
│  ├─ checks.js         # doctor：一次 Python 调用拿回全部环境信息
│  └─ stages.js         # 阶段命令构造 + FLOW/DECISIONS/GATES（方法论）
└─ test\
   ├─ harness.mjs       # mock-ctx 契约自检（35 项，不重启 DSH）
   └─ e2e.mjs           # 真机端到端（真跑 Python 流水线）
```

---

## 9 · 本机安装状态 / 卸载 / 分享

### 已安装（2026-10-15，官方入口）

```powershell
& 'D:\DSH\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add 'D:\AI-Song\dsh-plugin-cover'
# 输出：+ dsh-cover-pipeline link:D:/AI-Song/dsh-plugin-cover     exit=0
```

它自动做了三件事（**不需要手改任何文件**）：

| 动作 | 结果 |
|---|---|
| 写 profile 的 `dependencies` | `"dsh-cover-pipeline": "link:D:/AI-Song/dsh-plugin-cover"` |
| 写 profile 的 `dsh.profile.bundles` | 追加 `"dsh-cover-pipeline"` |
| 建 `node_modules` 链接 | `Junction` → `D:\AI-Song\dsh-plugin-cover`（**链接**，改源码即时生效） |

**生效方式**：DSH 在**运行中热加载**了它 —— 无需重启即出现 `cover_*` 系列工具。
（若你的版本没热加载，重启 DSH 即可；启动日志里会有
`[cover-pipeline] 已注册 11 个工具: …`。）

**验证**：在 DSH 里调用 `cover_doctor` —— 本机实测 **20 项全绿、0 警告**。

### 卸载 / 回滚

```powershell
# 干净卸载（官方入口，会同时从 bundles 与 dependencies 里移除）
& 'D:\DSH\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop remove dsh-cover-pipeline

# 极端情况：直接编辑 profile 的 package.json，删掉 dependencies 与 bundles 里的那两项
# 然后重启 DSH。profile 目录：%USERPROFILE%\.dsh\profiles\desktop\
```

> 卸载**不会**删除插件源码（`D:\AI-Song\dsh-plugin-cover`），也不会动流水线工程。

### 分享

```powershell
# 分享版 zip（git archive 产出，不含 .git、不含任何音频/权重）
D:\AI-Song\_交付\DSH插件_翻唱流水线\dsh-cover-pipeline-v1.0.0.zip
# 41 KB ｜ 16 条目 ｜ sha256 前 16 位 7BE0C90F54FD230E
```

**接收方怎么用**：解压 → 改 `cordis.patch.yml` 里的路径（或设 `DSH_COVER_ROOT`）
→ `dsh plugin --profile <profile> add <解压目录>` → 跑 `cover_doctor`。

★ 仓库里的 `.gitattributes` 钉了 `* -text`：本插件与配套工程都靠 **sha256 做逐字节自证**，
Windows 上若让 git 自动转换 CRLF↔LF，会让校验静默失效 —— 这是踩过的坑，别去掉。

