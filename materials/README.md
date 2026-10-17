# 材料包（models / 整合包）

**先说结论**：插件的 **15 个流水线脚本已经随仓库分发**，你不再需要去找「p51–p97」原工程目录。
还缺的只有三样**大文件**：MSST 整合包、DDSP 6.2 整合包、8 人音色模型包。它们不放进 git。

## 为什么不塞进 git

| 原因 | 具体 |
|---|---|
| 体积 | 三包合计约 **5 GB**；8 个音色模型单个 **267 MB**，超过 GitHub 单文件 100 MB 上限 |
| 许可 | 插件 MIT **不覆盖**第三方权重、音色、词曲、录音；音色模型是衍生权重，公开再分发有授权风险 |
| 可替换 | 音色模型可按需只拿一个；全塞进仓库会让只想试一个音色的人也下 2 GB |

仓库里 `scripts/publish.ps1` 的拒绝清单也写死了：`*.pt / *.ckpt / *.wav / *.mp3` 一律不许进 git。
这是有意为之，不是漏传。

## 三样材料（百度网盘，原分享，非本仓库再分发）

| # | 材料 | 链接 | 提取码 | 解压到 |
|---|---|---|---|---|
| 1 | MSST-GUI 人声分离整合包 | <https://pan.baidu.com/s/1gLO9U5jcfrtO3WJmAAyo1Q?pwd=u3r2> | `u3r2` | `<根>/01_人声分离_MSST-GUI` |
| 2 | DDSP-SVC 6.2 整合包（50 系 env） | <https://pan.baidu.com/s/16LUHAc40KsCI449TbPQ29Q?pwd=j44k> | `j44k` | `<根>/02_模型推理_DDSP-SVC-6.2/DDSP-barbara-6.2` |
| 3 | 8 人音色模型包 | <https://pan.baidu.com/s/1GJBrq3287GA_KKwNudFDpw?pwd=2aj9> | `2aj9` | `<根>/03_音色模型_MYGO-AveMujica` |

来源：B 站 UP 主「路边墨缇斯」教程 `BV1JU2LBZEt5`；整合包作者 @领航员未鸟。
**许可按原分享与包内说明**；本仓库只记录链接、落位与 sha256，不再分发权重。

## 期望的目录

```
<根>/                                   # 默认自动发现 D:/AI-Song
├─ 01_人声分离_MSST-GUI/
│  ├─ inference.py
│  ├─ env/python.exe                    # 50 系可用
│  ├─ pretrain/MelBandRoformer_kim.ckpt
│  └─ pretrain/bs_roformer_karaoke_frazer_becruily.ckpt
├─ 02_模型推理_DDSP-SVC-6.2/
│  └─ DDSP-barbara-6.2/
│     ├─ batch_infer.py
│     ├─ env/python.exe
│     └─ pretrain/{contentvec/…, pc_nsf_hifigan_…/model.ckpt}
└─ 03_音色模型_MYGO-AveMujica/
   └─ 祥子_步数20000/exp/reflow-test/{model_20000.pt, config.yaml}
```

## 校验（不用打开 DSH）

```powershell
# 只看清单与缺失项
node scripts/verify-materials.mjs --root D:/AI-Song

# 指定音色，并把发现的路径写入 cover.local.json（插件下次加载生效）
node scripts/verify-materials.mjs --root D:/AI-Song --voice 祥子 --write-config
```

脚本会做三件事：① 核对随包 15 个脚本；② 核对目录/权重是否存在；③ 只对**选中的音色**算 sha256
（避免每次把 2 GB 全哈希一遍）。清单与哈希见 [`manifest.json`](manifest.json)。

## 「一句话接入」怎么走

材料解压到位后，用户只需一句：

> 用祥子的声音翻唱这首歌。

代理侧调用顺序：`cover_setup(voice="祥子")` → `cover_doctor` → `cover_plan` → `cover_separate` …
`cover_setup` 会自动发现根目录、列出 8 个音色、给出可直接粘的配置片段；`cover_convert` 现在支持
`voice:"祥子"`，不必手填 `.pt` 路径。

## 想改成 GitHub 直链？

可以，但需要仓库 owner 的 token 建 **Release asset**（单文件上限 2 GB，仍受许可约束）。
在拿到明确授权前，本仓库只放清单与哈希，不搬运权重。
