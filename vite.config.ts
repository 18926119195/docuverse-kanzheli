import { defineConfig, type ProxyOptions, type UserConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { llmUpstream, zhipuApiKey } from './api/_lib/env.js'
import { pdfJsWasmPlugin } from './server/pdfJsWasmPlugin.js'
import { viteProtocolApiPlugin } from './server/viteProtocolApiPlugin.js'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const root = import.meta.dirname
  const protocolPlugin = viteProtocolApiPlugin(root, mode)
  const zhipuKey = zhipuApiKey()
  const upstream = llmUpstream()
  const proxy: Record<string, ProxyOptions> = {}

  if (zhipuKey) {
    proxy['/api/zhipu'] = {
      target: 'https://open.bigmodel.cn',
      changeOrigin: true,
      rewrite: (p) => p.replace(/^\/api\/zhipu/, '/api/paas/v4'),
      configure: (server) => {
        server.on('proxyReq', (request) => {
          request.setHeader('Authorization', `Bearer ${zhipuKey}`)
        })
      },
    }
  }
  if (upstream.apiKey) {
    proxy['/api/llm'] = {
      target: upstream.baseUrl,
      changeOrigin: true,
      rewrite: (p) => p.replace(/^\/api\/llm/, ''),
      configure: (server) => {
        server.on('proxyReq', (request) => {
          request.setHeader('Authorization', `Bearer ${upstream.apiKey}`)
        })
      },
    }
  }

  const config: UserConfig = {
    plugins: [react(), pdfJsWasmPlugin(root), protocolPlugin],
    // Production: no sourcemaps → Sources 看不到 intrinsicKey.ts 等源文件名
    build: {
      sourcemap: false,
      minify: 'oxc',
      target: 'es2022',
      cssMinify: true,
      reportCompressedSize: false,
      chunkSizeWarningLimit: 1200,
    },
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      // chat-archive jsonl 常被其它进程锁住，监视会 EBUSY 把整服打崩
      watch: {
        ignored: [
          '**/docs/chat-archive/**',
          '**/聊天记录*/**',
          '**/agent-transcripts/**',
        ],
      },
      proxy,
    },
  }
  return config
})
