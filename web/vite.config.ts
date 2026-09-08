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

// 同样的手法给「自动生成物判据」：core/generatedArtifacts.cjs 自己吐出 ESM 源码，
// 前端 import 'virtual:generated-artifacts'。判撞车这件事 CLI / server / 前端必须同一份判据，
// 前端另抄一份正则迟早对不上（卡 BOARD-FILESCOPE-INDEX-POLLUTION）。
function generatedArtifactsVirtualPlugin(): Plugin {
  const VID = 'virtual:generated-artifacts'
  const RESOLVED = '\0' + VID
  return {
    name: 'virtual-generated-artifacts',
    resolveId(id) {
      if (id === VID) return RESOLVED
    },
    load(id) {
      if (id !== RESOLVED) return
      const require = createRequire(import.meta.url)
      return require('../core/generatedArtifacts.cjs').toEsmSource()
    },
  }
}

// 同上：「这张卡此刻还算不算数」的判据 core/taskSignal.cjs 也走虚拟模块 'virtual:task-signal'。
// 总览的"需要你处理"、风险面板的"阻塞"、占用防撞的"冲突"全都建立在这一个判断上，
// 三个视图各写各的正是审计 B1/B2 那堆假数字的来源，所以判据必须只有一份。
function taskSignalVirtualPlugin(): Plugin {
  const VID = 'virtual:task-signal'
  const RESOLVED = '\0' + VID
  return {
    name: 'virtual-task-signal',
    resolveId(id) {
      if (id === VID) return RESOLVED
    },
    load(id) {
      if (id !== RESOLVED) return
      const require = createRequire(import.meta.url)
      return require('../core/taskSignal.cjs').toEsmSource()
    },
  }
}

// 决策落地判据与 CLI / server 同源，终态卡的未标记决策只作推定落地展示。
function decisionLandingVirtualPlugin(): Plugin {
  const VID = 'virtual:decision-landing'
  const RESOLVED = '\0' + VID
  return {
    name: 'virtual-decision-landing',
    resolveId(id) {
      if (id === VID) return RESOLVED
    },
    load(id) {
      if (id !== RESOLVED) return
      const require = createRequire(import.meta.url)
      return require('../core/decisionLanding.cjs').toEsmSource()
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
    plugins: [vue(), boardSchemaVirtualPlugin(), generatedArtifactsVirtualPlugin(), taskSignalVirtualPlugin(), decisionLandingVirtualPlugin(), ...(useMock ? [mockApiPlugin()] : [])],
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
      // echarts 懒加载 chunk 约 1MB 属预期（仅甘特/依赖图访问时才载、绝不进首屏），抬高阈值免误报
      chunkSizeWarningLimit: 1200,
      rollupOptions: {
        output: {
          // 把 vue 核心运行时拆成稳定的 vendor chunk（应用代码更新不失效其缓存）；
          // echarts 家族刻意不并入 vendor，交给 Rollup 默认按动态 import 保持懒加载。
          manualChunks(id: string) {
            if (!id.includes('node_modules')) return
            if (/[\\/]node_modules[\\/](echarts|zrender|vue-echarts|resize-detector)[\\/]/.test(id)) return
            if (/[\\/]node_modules[\\/](@vue[\\/]|vue[\\/]|vue-router[\\/]|pinia[\\/])/.test(id)) return 'vendor'
          },
        },
      },
    },
  }
})
