# Docuverse 看这里入库指南

这里维护 PDF 布局、OCR、bookKey 与材料贴条的来源关系。先用合成 55 页夹具建立页序和并发的基准，再接浏览器的导入与结算。审阅基线为 [main · d994535](https://github.com/18926119195/docuverse-kanzheli/commit/d994535d9b1b99b0ca63459e5e41a275e86442b2)。

## 阅读顺序

- [开发沿革 KZ-01 至 KZ-07](DEVELOPMENT_HISTORY.txt) 有原句时间、源码行和逐项边界。[聊天目录](docs/chat-archive/README.md) 按主题查会话；[维护入口](MAINTAINERS.txt) 看可比较的仓库。
- 导入从 [PdfUploadPanel](src/ui/PdfUploadPanel.tsx) 顺读 [pdfPagePipeline](src/data/pdfPagePipeline.ts)、[TocWizard](src/ui/TocWizard.tsx) 和 [bookKey](src/arch/bookKey.ts)。改贴条先看 [peekCast](src/reasoning/peekCast.ts) 与 [harnessGateway](src/reasoning/harnessGateway.ts)。
- 问答从 [A1ChatDock](src/ui/A1ChatDock.tsx) 看 [autoFlow](src/reasoning/autoFlow.ts)。查路径候选到 normKey 用 [pathLineageBind](src/reasoning/pathLineageBind.ts) 和 [SettlementDeskPanel](src/ui/SettlementDeskPanel.tsx)。

## 开发意图与现状

| 会话与提交 | 已接入的行为 | 待验收 |
| --- | --- | --- |
| 9 月 8 日 KZ-01/02，layout 负责锁地址、同批 LLM 调用形成面板。 [地址与强调笔原件](docs/chat-archive/2026-09-08-bookkey-emphasize-region-combo.jsonl) · [批面板原件](docs/chat-archive/2026-09-08-intent-llm-sphere-construction.jsonl) | 书门由 docId、页、layoutK 确定，书面选区的身份继续保留；[进度图](src/reasoning/turnJobProgress.ts) 使用 llmCallId 与成员 keys。 | 多种 PDF 的布局误差、WebGL 交互和页面跳转。 |
| 9 月 9 日 KZ-03，同源 path 经用户或监督登记 norm。 [原件](docs/chat-archive/2026-09-09-path-lineage-supervise-norm.jsonl) | [落账](src/reasoning/attentionIoStore.ts) 与 [写信台](src/reasoning/letterDeskDispatch.ts) 接到用户选择和监督选材。 | 确认、撤销、改写、自动结算分别做完整用户路径。 |
| 9 月 10 日 KZ-04/05，分批 decide、TOC 按 strand、扫描件头尾各 20 页，随后后台 OCR。 [结算讨论](docs/chat-archive/2026-09-10-settlement-ui-toc-map-399aab3e.jsonl) · [OCR 讨论](docs/chat-archive/2026-09-10-bookkey-ocr-ingest-pipeline-9175a123.jsonl) | 有并发池、目录先行、增量语料和母族隔离。夹具覆盖 55 页头尾范围、同族多贴和跨族必须显式修贴。 | 真实扫描件、取消或中断恢复、供应商取消生成或计费。 |
| 9 月 11 日 KZ-06，[独立分支](https://github.com/18926119195/docuverse-kanzheli/tree/experiment/no-peek-prospect-as-index) | 无 peek 的冷进门与 prospect 父项实验留在该分支；main 具有上述 peek 行为。 | 是否合并要先比同语料的 key 来源完备率、通路和回滚成本。 |
| 11 月 19 日 KZ-07，[整理 PR](https://github.com/18926119195/docuverse-kanzheli/pull/1) | 主分支修复 peek 类型、三态、环境配置和构建，补会话导航与 [离线检查](scripts/check-system.mjs)。 | 部署环境和真实 OCR 仍需单独验证。 |

## 运行、观测与纠偏

```sh
npm ci --ignore-scripts
npm run build
npm run check:system
npm run dev
```

本次 Node 24.22.1 的安装、构建、离线系统检查均通过。夹具验证 BM25、同问键、状态归一、55 页调度、并发池峰值 2、同族多贴及跨族修贴。构建有包体提示。`dev` 用于浏览器验证，真实服务配置见 [后端说明](docs/VERCEL_BACKEND.md)。

1. **输入与基准**。选择文本层 PDF、扫描 PDF、语料包三条入口，各取同一份许可内的最小资料。记录页数、页序、layoutK、bookKey、briefKey、`peekFamilyId`、读写结果和目录可用时刻。真实 OCR 扰动用空页、超时和页重试模拟。
2. **先守不变量**。55 页测试前后合计 40 页进入首批，中间不重复进首批；并发峰值保持所设值 2。记录跨族直接追加拒绝和显式 `revise` 成功。端到端夹具验收要求每个输出 key 可追溯到目标页与母族，错误归属为 0。
3. **按失败层闭环**。页序偏差先查 PDF 调度与取消，key 错位查 layout 与落账，越族查修贴模式和母族。维护者事前确认端到端 OCR、UI 和响应时延所需的样本与限额；发现退化先保留失败输入与旧/新台账，再决定该改动是否回退。

## 方法依据

本指南把总体设计落实为边界、目标和任务接口，把工程控制中的反馈落实为观测、判据和纠偏。维护者用原始协作记录、代码和固定样本共同核验定性判断与量化结果，据此决定下一轮行动。[《工程控制论》](https://openlibrary.org/books/OL49218199M/Engineering_cybernetics) · [《组织管理的技术——系统工程》](https://doi.org/10.13255/j.cnki.jusst.2011.06.020) · [《一个科学新领域——开放的复杂巨系统及其方法论》](https://cnki.istiz.org.cn/kcms/detail/detail.aspx?dbcode=CPFD&dbname=cpfd1999&filename=ZGXC199008001001)
