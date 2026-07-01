// echarts 按需加载辅助：只被懒加载的图表视图 import()，因此 echarts 只进这些视图的 chunk，
// 绝不出现在首屏 bundle（R8）。init 完成后回调 onReady 可注册交互（点击等）。
import { ref, shallowRef, onMounted, onBeforeUnmount } from 'vue'

// echarts 类型经动态 import 引入，这里用 any 避免首屏静态引用类型
type AnyChart = { setOption: (o: unknown, notMerge?: boolean) => void; resize: () => void; dispose: () => void; on: (ev: string, cb: (p: unknown) => void) => void }

export function useEchart(optionFactory: () => unknown, onReady?: (chart: AnyChart) => void) {
  const el = ref<HTMLElement | null>(null)
  const chart = shallowRef<AnyChart | null>(null)
  let ro: ResizeObserver | null = null

  async function init() {
    const echarts = await import('echarts')
    if (!el.value) return
    const c = echarts.init(el.value, undefined, { renderer: 'canvas' }) as unknown as AnyChart
    chart.value = c
    c.setOption(optionFactory())
    ro = new ResizeObserver(() => c.resize())
    ro.observe(el.value)
    onReady?.(c)
  }
  function update() {
    if (chart.value) chart.value.setOption(optionFactory(), true)
  }
  onMounted(init)
  onBeforeUnmount(() => {
    ro?.disconnect()
    chart.value?.dispose()
    chart.value = null
  })
  return { el, chart, update }
}
