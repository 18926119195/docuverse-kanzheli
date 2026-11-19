# Docuverse 看这里入库指南

[一分钟定位](#一分钟定位) · [沿聊天时间线看灵感](#沿聊天时间线看灵感) · [从代码反查来由](#从代码反查来由) · [走读与维护记录](#走读与维护记录)

## 一分钟定位

这是 Docuverse 中研究 PDF 证据来源的一版。书页版面决定 bookKey 的归属，OCR 提供字，peek 产生可打开的材料贴条，路径再由用户或监督结算。初次进入可以从一页扫描件追到目录、问答和贴条。阅读基线为 [main · d994535](https://github.com/18926119195/docuverse-kanzheli/commit/d994535d9b1b99b0ca63459e5e41a275e86442b2)。[开发沿革](DEVELOPMENT_HISTORY.txt)保留 KZ-01 至 KZ-07 的原句和历史代码。

## 沿聊天时间线看灵感

**如何读状态。** 已实现表示在所列版本找到与灵感相符的代码路径。部分实现表示已有其中一段。未实现表示已查的入口尚无对应实现。证据不足时标待确认。归档与设计文稿按资料本身的状态描述。

日期是北京时间。9 月 8–9 日的会话可找到原件，相关代码最早快照为 9 月 10 日，二者的日期分别列出。[聊天目录](docs/chat-archive/README.md)

| 编号与聊天原件 | 当时提出的思路 | 当前状态与代码证据 |
| --- | --- | --- |
| <a name="idea-i01"></a>I01 · 9 月 8 日 09:48 与 11:22，[版面 L38](docs/chat-archive/2026-09-08-bookkey-emphasize-region-combo.jsonl#L38) · [强调笔 L168](docs/chat-archive/2026-09-08-bookkey-emphasize-region-combo.jsonl#L168) | 把书键钉在 layout 坐标上，点到已有区域时指回其键，空白才进入铸键。 | **已接入。** bookKey 由文档、页、layoutK 构成，强调笔区分铸键与引用。多 PDF 的选区准确度未测。 [bookKey](src/arch/bookKey.ts) · [强调笔](src/reasoning/emphasizeMint.ts) |
| <a name="idea-i02"></a>I02 · 9 月 8 日 13:55，[批面板 L168](docs/chat-archive/2026-09-08-intent-llm-sphere-construction.jsonl#L168) | 把一次模型调用中同类型的键集中在一个面板，反映问答正在进行的步骤。 | **已接入场景，视觉走读待验证。** 进度图读取本轮调用账，边记录 `llmCallId` 和成员 keys，界面可显示该批。 [进度图](src/reasoning/turnJobProgress.ts) · [场景](src/canvas/CvsScene.tsx) |
| <a name="idea-i03"></a>I03 · 9 月 9 日 19:02，[路径 L220](docs/chat-archive/2026-09-09-path-lineage-supervise-norm.jsonl#L220) | 用户确认路径后登记为 normKey，也能撤销或整理后再确认。 | **已接入，完整界面流程待验证。** 同源证据绑定路径候选，用户或监督可从调度链结算。 [路径绑定](src/reasoning/pathLineageBind.ts) · [结算界面](src/ui/SettlementDeskPanel.tsx) · [落账](src/reasoning/attentionIoStore.ts) |
| <a name="idea-i04"></a>I04 · 9 月 10 日 12:03 与 13:31，[分批 L59](docs/chat-archive/2026-09-10-settlement-ui-toc-map-399aab3e.jsonl#L59) · [目录 L170](docs/chat-archive/2026-09-10-settlement-ui-toc-map-399aab3e.jsonl#L170) | 让 decide 分批并行，并让目录明确每节对应的页槽范围，供冷启动分配。 | **已接入。** 自动流有限并发，目录召回按 strand 组织。真实模型响应和供应商对取消的处理待验证。 [自动流](src/reasoning/autoFlow.ts) · [目录向导](src/ui/TocWizard.tsx) |
| <a name="idea-i05"></a>I05 · 9 月 10 日 15:46，[OCR L118](docs/chat-archive/2026-09-10-bookkey-ocr-ingest-pipeline-9175a123.jsonl#L118) | 扫描件先取头尾各 20 页用于分节，中间随后处理。 | **已实现调度。** 合成 55 页夹具观测到头尾 40 页、15 页中间队列与并发峰值 2。真实 OCR 未复跑。 [OCR 调度](src/data/pdfPagePipeline.ts) · [系统夹具](scripts/check-system.mjs) |

9 月 11 日的 no-peek 冷启动只有代码证据，归档里未找到对应会话。该版本让 prospect 以 bookKey 作父项，**仅在实验分支实现**。 [实验源码](https://github.com/18926119195/docuverse-kanzheli/blob/42ea3d012f2aa68c1ac3a145792d653beb0cc144/src/arch/noPeekExperiment.ts#L11-L42)11 月 19 日的 [主分支整理](https://github.com/18926119195/docuverse-kanzheli/pull/1) 修复了 peek 类型与环境配置并保留主分支贴条行为。

## 从代码反查来由

- [PdfUploadPanel](src/ui/PdfUploadPanel.tsx) → [pdfPagePipeline](src/data/pdfPagePipeline.ts) → [TocWizard](src/ui/TocWizard.tsx) 回看 [I04](#idea-i04)–[I05](#idea-i05)。从界面区分目录可用时机与后台 OCR 完成时机。
- [bookKey](src/arch/bookKey.ts) 与 [emphasizeMint](src/reasoning/emphasizeMint.ts) 回看 [I01](#idea-i01)，定位书门和已登记区域的分享关系。
- [turnJobProgress](src/reasoning/turnJobProgress.ts) 回看 [I02](#idea-i02)；[pathLineageBind](src/reasoning/pathLineageBind.ts) 与 [SettlementDeskPanel](src/ui/SettlementDeskPanel.tsx) 回看 [I03](#idea-i03)。

## 走读与维护记录

第一次遇到“首批为什么有 40 页”，看 [55 页离线夹具](scripts/check-system.mjs)，对照返回中的 `edges` 与 `middle`，再回 [I05](#idea-i05) 查看作者为何用页数。Node 24 的生产构建和 `npm run check:system` 通过，真实扫描 OCR、浏览器全链路和模型部署未复跑。补写状态时保留会话位置，说明新证据来自主分支还是实验分支，附上所用提交与实际入口。

**指南如何更新。** 以仓库和版本划定范围，从聊天提取原始目标，再用代码与产物校正对当时决策的理解。新证据出现时，回到原编号修订记录。这种读法借鉴了钱学森的系统工程和工程控制论。 [《组织管理的技术——系统工程》](https://doi.org/10.13255/j.cnki.jusst.2011.06.020) · [《工程控制论》](https://openlibrary.org/books/OL49218199M/Engineering_cybernetics)
