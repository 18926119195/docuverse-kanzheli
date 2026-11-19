import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('../', import.meta.url))
const saved = new Map()
globalThis.window = {
  localStorage: {
    getItem: (key) => saved.get(key) ?? null,
    setItem: (key, value) => saved.set(key, value),
    removeItem: (key) => saved.delete(key),
  },
  setTimeout,
}
globalThis.localStorage = window.localStorage
const server = await createServer({ root, configFile: false, envFile: false, server: { middlewareMode: true, watch: null, ws: false } })
try {
  const load = (path) => server.ssrLoadModule('/src/' + path + '.ts')
  const { bm25Rank } = await load('reasoning/hybridRetrieve')
  const ranked = bm25Rank('置信区间', ['玻璃金属与树木', '置信区间、区间估计'], 2)
  assert.equal(ranked[0].index, 1)
  const {normalizeIncrementStatus} = await load('arch/keyIncrementStatus')
  assert.deepEqual(
    ['不充分', '不够用', 'not enough', '充分', '未读'].map(normalizeIncrementStatus),
    ['insufficient', 'insufficient', 'insufficient', 'sufficient', 'unread'],
  )
  const {useAttentionIo} = await load('reasoning/attentionIoStore')
  const st = useAttentionIo.getState()
  const current = st.ensureQueryKey('当前问题')
  assert.equal(st.ensureQueryKey(' 当前问题 '), current)
  console.log('BM25 排名、三态及同问复用 queryKey 通过')
  const {executePeekCast} = await load('reasoning/peekCast')
  const {rollDoorBrief} = await load('reasoning/keyDecisionState')
  const {scheduleStrandsHeadTailThenMiddle} = await load('data/pdfPagePipeline')
  const {runBatchesParallel} = await load('arch/parallelLlmBatch')
  const peek = (taskId, text) => executePeekCast({
    docId: 'smoke', bookIndex: {chunks: []},
    peekIn: {key:'book_1', approvedKeys:['book_1'], taskId},
    peekOut: { key:'book_1', decisionBrief:text, suggestAction:'open' },
  })
  const fresh = peek('family-a','第一条摘要')
  assert.equal(fresh.ok, true)
  assert.equal(fresh.entry.key, 'book_1')
  const sibling = peek('family-a','第二条摘要')
  assert.equal(sibling.ok, true)
  assert.notEqual(sibling.entry.briefKey, fresh.entry.briefKey)
  assert.equal(peek('family-b','外族直接追加').ok, false)
  const revise = rollDoorBrief({docId:'smoke',key:'book_1', decisionBrief:'明确修贴', suggestAction:'open', peekFamilyId:'family-b', hangMode:'revise'})
  assert.equal(revise.ok, true)
  assert.equal(revise.hung, 'revise')
  assert.equal(scheduleStrandsHeadTailThenMiddle(55).edges.length, 40)
  assert.deepEqual(scheduleStrandsHeadTailThenMiddle(55).middle, Array.from({length:15}, (_,i)=>20+i))
  let flights = 0
  let peak = 0
  const ran = await runBatchesParallel({batches: [1, 2, 3, 4], concurrency: 2, run: async (n) => {
    peak = Math.max(peak, ++flights)
    await new Promise(resolve => setTimeout(resolve, 3))
    flights -= 1
    return n
  }})
  assert.equal(peak, 2)
  assert.equal(ran.results.filter((r)=>r.ok).length, 4)
  console.log('peek 同族多贴与跨族显式修贴、头尾各 20 页、并发池通过')
} finally {
  await server.close()
}
