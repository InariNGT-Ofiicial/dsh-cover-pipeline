# 依赖与下载入口

本页按已审计的 **baseline、key=0、两级分离、混音与检查** 路线整理。它是组件清单和兼容性说明，不是已验证的干净装机教程。

**版本边界：** 审计对象是 1.1.2 工作版本；本次起 1.1.2 实现与随包脚本已并入 `main`。本页只记录依赖层级与审计边界，不替代 `cover_doctor` 的运行时探测。

## 最少准备四组组件

| 组件 | 默认路线需要什么 | 官方或上游入口 |
| --- | --- | --- |
| DSH 宿主＋插件 | 兼容的宿主运行环境与插件配置。插件没有运行时 npm dependencies；Cordis 由宿主提供。 | [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) |
| MSST 分离工程 | CLI 推理代码、兼容 Python/PyTorch 环境、Kim 与 karaoke 两组权重及对应配置。 | [MSST](https://github.com/ZFTurbo/Music-Source-Separation-Training)、[模型与配置映射](https://github.com/ZFTurbo/Music-Source-Separation-Training/blob/main/docs/pretrained_models.md) |
| DDSP 推理工程 | 与目标音色匹配的代码和环境，以及下节列出的配置引用资产。 | [DDSP-SVC](https://github.com/yxlllc/DDSP-SVC) |
| 混音与检查实现 | `mix_master.py`、`verify_mix.py` **已随 1.1.2 包分发**（`runtime/`）；NumPy、SciPy、SoundFile、pyloudnorm、pedalboard 可放在已有分离环境中。 | 仓库内 `runtime/`，无需另找。 |

Python 库随各自兼容工程环境准备，不需要把每个底层库当作另一套软件逐个手动下载。已有环境应先核对，不要为“精简”直接卸载包。

### 宿主与环境

- Node 是宿主运行环境。桌面发行包若已自带兼容 Node，无需重复安装；CLI/源码安装按选定 DSH 版本的要求准备。插件声明的 Node `>=18` 不能代替宿主自身的版本要求。
- 两套 Python 环境是已测试部署的隔离方式，有助于避免库版本冲突；不是算法必须使用两个解释器。未验证任意合并环境都兼容。
- 默认入口调用 CLI，不要求打开 MSST GUI，也不要求安装另一套 DAW。

### 分离模型

1. [Kim MelBandRoformer 权重](https://huggingface.co/KimberleyJSN/melbandroformer/tree/main)：分离人声与伴奏；配套 YAML 从 MSST 模型映射查找。
2. [BS-Roformer karaoke 权重与配置](https://huggingface.co/becruily/bs-roformer-karaoke/tree/main)：再将人声拆成主唱与和声。

两级均实际用于审计路线；只装第一组不能复现默认主唱/和声处理。调用需包含 `--extract_instrumental`。权重、配置、引擎要配套，已测试配置与当前上游示例存在推理参数差异，不能仅凭文件名替换。

### DDSP 配套资产

审计配置为 `RectifiedFlow / 44100 Hz / block_size 512 / contentvec768l12tta2x / RMVPE / PC-NSF-HiFiGAN`。

| 资产 | 用途与兼容要求 | 上游入口 |
| --- | --- | --- |
| 目标音色权重＋旁置 `config.yaml` | 决定模型结构、编码器、声码器及采样率；使用自行取得且有权使用的兼容权重。 | 由所选音色模型提供方提供；本仓库不分发音色权重。 |
| 旧 fairseq 格式 ContentVec | 实际配置引用 `checkpoint_best_legacy_500.pt`，加载器调用 `checkpoint_utils.load_model_ensemble_and_task`。 | [ContentVec 原项目与预训练说明](https://github.com/auspicious3000/contentvec) |
| RMVPE | baseline 指定 `-pe rmvpe`，用于提取音高。 | [RMVPE 230917 发布页](https://github.com/yxlllc/RMVPE/releases/tag/230917) |
| PC-NSF-HiFiGAN 权重＋旁置 `config.json` | 实际声码器；这份 JSON 与音色模型的 YAML 是两份不同配置。 | [44.1k / hop512 / 128bin / 2025.02 发布页](https://github.com/openvpi/vocoders/releases/tag/pc-nsf-hifigan-44.1k-hop512-128bin-2025.02) |

已测试的是 6.2 系本地 DDSP 代码；精确上游 commit 与完整环境锁定仍未形成可复现分发包。当前上游 6.3 的编码器路线不是本页确认的替代组合，不能把 `pytorch_model.bin` 改名来代替旧 fairseq checkpoint。也不需要把 README 中所有编码器和历代声码器都下载一遍。

## 算法没用，不等于旧入口可以缺包

| 依赖 | 审计发现 | 应如何理解 |
| --- | --- | --- |
| `torchcrepe` | DDSP `ddsp/vocoder.py` 顶层导入；baseline 实际选 RMVPE。隔离导入测试屏蔽 torchcrepe 后，入口启动失败。 | 当前旧代码仍需可导入；不表示 baseline 执行了 CREPE 算法。guided 某些选项会实际使用它。 |
| `pyworld`、`parselmouth`、`transformers` | 已测试 DDSP 入口顶层导入；对应可选算法未在本路线选中。 | 随兼容环境保留，不能仅凭本次算法未选中就卸载。 |
| `wandb`、`matplotlib`、`loralib` | MSST 推理入口间接顶层导入。 | 不需要运行训练或绘图，也不代表旧入口可以直接缺包。 |
| `fairseq` | 实际用于旧 ContentVec 加载。 | 本路线确实使用，不应归为“训练专用”。 |
| `pyloudnorm`、`pedalboard` | 实际混音/检查使用；前者测响度，后者提供 DSP。 | 虽然分离模型本身不用，仍是同一环境承担混音时的必要包。 |

以上说明针对实际入口，不是完整 requirements 的可卸载清单。没有逐一证明所有 GUI、训练和设备相关包都能安全删除。

## 按用途才需要

| 用途 | 条件依赖与边界 |
| --- | --- |
| MP3 交付或格式转换 | **复现已测试的 MP3 导出命令需要 FFmpeg**（`libmp3lame`）。对已经可读的 WAV，核心混音与检查不依赖 FFmpeg。其他编码器理论上可替代，但不属于该已验证导出路径；压缩输入解码还需按实际格式确认。 |
| 非八度移调 | 需要兼容移调助手；非八度 key 时主唱、伴奏、和声须保持调性关系。`key=0` 不需要执行此步骤。 |
| 专项 QC、裁剪、标签封装 | 仅在调用对应工具时准备助手及相关库，如 mosqito、mutagen、lameenc；不是默认 WAV 完成条件。 |
| 实验 guided | 单独准备、测试该后端需要的代码及选项，不能把 baseline 验收扩大为 guided 已验证。 |
| 训练、视频制作、人工修音 | 不是本次推理交付的必需操作。训练数据、视频制作工具、额外自动修音软件无需列入默认安装清单。 |

旧置顶说明已将 FFmpeg/QC/裁剪/封装列为按需，本页主要合并组件层级并明确条件，不把原有可选项误称为必装错误。

## 源码分发边界（1.1.2 已补齐脚本）

**8 个核心脚本已经随包**：5 个 runtime adapter + `shift.py` + `mix_master.py` / `verify_mix.py`，全部在 `runtime/`。旧歌工程里的 QC / 裁剪 / 封装脚本已移除，clone 之后不需要再去找任何旧工程目录。

仍未随包的是**大文件**：MSST 整合工程、DDSP 6.2 工程、ContentVec/RMVPE/HiFiGAN 预训练件、8 个音色模型。原因是单文件 100 MB 的 git 限制与第三方许可；落位、sha256 与网盘入口见 [materials/README.md](../materials/README.md)。

1.1.2 包内 `runtime/mix.py` 仍是适配器：它调用同目录 `mix_master.py` 的 `run`，限制一次响度归一化，并保留结果记录；`cover_verify` 执行同目录的 `verify_mix.py`。把三轨简单相加再 loudnorm 不等价于已测试的 EQ、压缩、去齿音、混响与母带链。

`cover_doctor` 会做自动发现（根目录、`01_/02_/03_`、`env/python.exe`），但它是运行时探测，不是依赖锁或干净装机证明。先配兼容工程和资产，再跑 doctor、做同段短试听和技术检查，最后由用户听审确认。数值通过不是听感或商业质量保证。

## 证据边界

- 审计依据：已完成的 baseline 全曲入口记录、两级分离结果、实际音色配置与源码调用关系。
- 轻量验证：CPU 导入；4 秒合成音频通过实际混音适配器与检查脚本。后者在阻断 Torch、librosa、torchcrepe、mosqito、mutagen、lameenc 导入及音频阶段外部进程后仍完成，支持它们不是该 WAV 混音路径的依赖。
- 随包脚本回归：`node test/regression.mjs`（15）、`node test/workflow.mjs`（6）、`node test/setup.mjs`（8）、`node test/harness.mjs`（28）、`node test/package.mjs`；`test/mix-cpu.py` 用随包 `runtime/` 实测 3 项。
- 未进行干净装机、逐包卸载、大歌曲重跑或新 GPU 验证。没有因此证明完整 DSH 界面中的全链执行，也没有改变已验收音频。

## 许可单独核对

插件的 MIT 许可只覆盖其许可范围，**不覆盖第三方源码、模型权重、音色、词曲和录音**。本页链接不授予再分发或商业使用权。

例如，上述 [PC-NSF-HiFiGAN 发布页](https://github.com/openvpi/vocoders/releases/tag/pc-nsf-hifigan-44.1k-hop512-128bin-2025.02) 将预训练权重标为 **CC BY-NC-SA 4.0**，并要求再分发者阅读包内 notice。其他资产分别按其原始许可和授权使用。许可限制、源码缺失和运行依赖是否必要，是三个不同问题。
