/**
 * 写信台契约表：job → allow/forbid + in/out 协议（正文不变，仅调度）。
 * 对齐：对称 key 出入 + 增量落账（方案 B settle）；正文指纹不当门牌。
 * 各工种 out 必须带输入 key 的增量三态：unread | sufficient | insufficient。
 */

import type { DeskJob } from '../reasoning/attentionIoStore'
import { keyStatusContractHint } from './keyIncrementStatus'

export type ContractKeyKind =
  | 'briefKey'
  | 'bookKey'
  | 'queryKey'
  | 'inferKey'
  | 'prospectKey'
  | 'pathKey'
  | 'normKey'

export interface DeskContract {
  job: DeskJob
  /** 本窗允许出现的门牌型（expand 只准产出这些） */
  allow: ContractKeyKind[]
  forbid: ContractKeyKind[]
  inNote: string
  outNote: string
}

export const DESK_CONTRACTS: Record<DeskJob, DeskContract> = {
  peek: {
    job: 'peek',
    allow: ['bookKey'],
    forbid: [],
    inNote:
      'bookKey（划重点铸门）+ T；layout 默信铸门，强调笔命中复用 / 未覆盖须确认再铸；' +
      '共享 page_norm 基底（同级 peer）',
    outNote:
      'briefs[{key, brief|briefs[], status}] + keyStatuses；' +
      '同 bookKey 多 brief = 多槽（多条或 briefs:["A","B"] 展开），台各 settle 铸 briefKey；' +
      '仅 sufficient 铸键；items[]/keep[] 已废除；' +
      keyStatusContractHint('bookKey'),
  },
  query: {
    job: 'query',
    allow: ['queryKey'],
    forbid: ['bookKey', 'briefKey'],
    inNote:
      '历史问族 queryKey+Q（含根与深化子问；排除 Q_now）+ Q_now（阶段 A · 无 brief）',
    outNote:
      'neighbours[{queryKey, degree}]（对称子集 + 相关度增量）；' +
      '台为每条 settle neighbourKey 挂在该 historic queryKey 上；' +
      keyStatusContractHint('queryKey'),
  },
  decide: {
    job: 'decide',
    allow: ['briefKey'],
    forbid: ['bookKey'],
    inNote: 'Q_now + {briefKey, brief}[]（无 bookKey/T）',
    outNote:
      'prospects[{briefKey, prospect|prospects[], status}] + keyStatuses；' +
      'briefKey 须字符级回传窗内门牌；多种可能=多槽各 settle；' +
      '仅 sufficient 铸 prospectKey；unread/insufficient 只记状态；' +
      '整窗 coverage 已废；可选 stopReason/seedRange 草案（可半开）；' +
      '台晚执行：锚点须已读、半开配对成闭集后才热启 peek；' +
      keyStatusContractHint('briefKey'),
  },
  supervise: {
    job: 'supervise',
    allow: ['pathKey'],
    forbid: [],
    inNote:
      '台已铸候选 pathKey（血缘绑定 infer×prospect）；展开 ι∥prospect 正文；' +
      '用户未 tick、也未自整理时进本工种：信效度+写出归一化正文，台铸 normKey',
    outNote:
      'judgments[{pathKey,status,normalizedText}]：sufficient→台铸 normKey（infer 为底、prospect 修饰）；' +
      'insufficient 不铸；禁止输出未绑定 pathKey；' +
      '对照：用户 tick 时台直接把 path 内容登记为 norm（可自带整理文），不经本 LLM；' +
      keyStatusContractHint('pathKey'),
  },
  infer: {
    job: 'infer',
    allow: ['bookKey'],
    forbid: [],
    inNote:
      '材料 bookKey(+T) + Q_now；可选玩法B排除：inferKey+ι原文（钉ι换方向）；' +
      'reuse失败不向infer塞旧问法——只在decide前剔path用过的briefKey',
    outNote:
      'paths[] + materialStatus/keyStatuses；台每步/每槽 settle 铸 inferKey（一槽一 key）；' +
      '增量字段名=infer（可用 infers[]）；禁止正文哈希合并；' +
      '先铸候选 pathKey（beginPendingPathMatch）；用户确认→台登记 normKey，或跳过→监督铸 normKey；' +
      '一条 query 可多条 path；同窝可多对；用户调取多少看多少；' +
      keyStatusContractHint('bookKey'),
  },
}

export function lookupContract(job: DeskJob): DeskContract {
  return DESK_CONTRACTS[job]
}
