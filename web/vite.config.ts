import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'
import { mockApiPlugin } from './mock/mockServer'

// base './'：dist 可被 server 从任意子路径静态托管。
// 默认 dev：/api 代理到真 server(127.0.0.1:6060)。
// mode=mock（npm run dev:mock）：改用内置 mock 中间件联调，业务代码无 mock 分支。
export default defineConfig(({ mode }) => {
  const useMock = mode === 'mock'
  return {
    base: './',
    plugins: [vue(), ...(useMock ? [mockApiPlugin()] : [])],
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
        // 复用 core 零依赖底座（状态枚举/emoji 单一真相源）
        '@core': fileURLToPath(new URL('../core', import.meta.url)),
      },
    },
    server: {
      port: 5173,
      strictPort: false,
      // 放开对上层 ../core 的读取（dev 下 import @core/boardSchema.cjs）
      fs: { allow: ['..'] },
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
