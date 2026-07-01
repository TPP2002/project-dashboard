import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'
import { createRequire } from 'node:module'
import { mockApiPlugin } from './mock/mockServer'

// 单一真相源：Node 端 require core/boardSchema.cjs（CJS），把 STATUS/STATUS_EMOJI 内联成 ESM
// 虚拟模块 'virtual:board-schema' 供前端 import。dev 与 build 完全一致、零漂移，
// 既不改 core、也不让浏览器直接加载 .cjs（避免 dev 下 ReferenceError: module is not defined）。
function boardSchemaVirtualPlugin(): Plugin {
  const VID = 'virtual:board-schema'
  const RESOLVED = '\0' + VID
  return {
    name: 'virtual-board-schema',
    resolveId(id) {
      if (id === VID) return RESOLVED
    },
    load(id) {
      if (id !== RESOLVED) return
      const require = createRequire(import.meta.url)
      const schema = require('../core/boardSchema.cjs')
      const { SCHEMA_VERSION, STATUS, STATUS_EMOJI } = schema
      return [
        `export const SCHEMA_VERSION = ${JSON.stringify(SCHEMA_VERSION)}`,
        `export const STATUS = ${JSON.stringify(STATUS)}`,
        `export const STATUS_EMOJI = ${JSON.stringify(STATUS_EMOJI)}`,
        `export function emojiFor(s){ return STATUS_EMOJI[s] || '\\u2b1c' }`,
        '',
      ].join('\n')
    },
  }
}

// base './'：dist 可被 server 从任意子路径静态托管。
// 默认 dev：/api 代理到真 server(127.0.0.1:6060)。
// mode=mock（npm run dev:mock）：改用内置 mock 中间件联调，业务代码无 mock 分支。
export default defineConfig(({ mode }) => {
  const useMock = mode === 'mock'
  return {
    base: './',
    plugins: [vue(), boardSchemaVirtualPlugin(), ...(useMock ? [mockApiPlugin()] : [])],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      port: 5173,
      strictPort: false,
      proxy: useMock
        ? undefined
        : {
            '/api': {
              target: 'http://127.0.0.1:6060',
              changeOrigin: true,
            },
          },
    },
    build: {
      outDir: 'dist',
      chunkSizeWarningLimit: 900,
    },
  }
})
