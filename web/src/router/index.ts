// 全部视图路由级懒加载（() => import() 自动分 chunk）：首屏只含入口 + Overview，
// echarts 仅存在于 Gantt / DependencyGraph 的独立 chunk，绝不进首屏（R8）。
// hash 历史：dist 被 server 从任意子路径静态托管、刷新不 404、双击可开。
import { createRouter, createWebHashHistory } from 'vue-router'
import type { IconName } from '@/icons/paths'
import type { ModuleId } from '@/api/client'
import { useBoardStore } from '@/stores/board'

// meta.icon 存的是功能图标的名字（icons/paths.ts 里的键），不是字符——
// 界面要画图标时用 <Icon :name="..." />，这样路由表和侧栏说的是同一套图标语言。
// 下面的 satisfies 会在编译期挡住写错的图标名（索引签名是为了放行 path/name/component 这些字段）。
interface RouteMeta { title: string; icon: IconName; module?: ModuleId }

const routes = [
  { path: '/', redirect: '/overview' },
  { path: '/overview', name: 'overview', component: () => import('@/views/Overview.vue'), meta: { title: '总览', icon: 'home' } },
  { path: '/kanban', name: 'kanban', component: () => import('@/views/Kanban.vue'), meta: { title: '看板', icon: 'kanban' } },
  { path: '/approvals', name: 'approvals', component: () => import('@/views/ApprovalCenter.vue'), meta: { title: '待拍板', icon: 'bell' } },
  { path: '/reader', name: 'reader', component: () => import('@/views/Reader.vue'), meta: { title: '审阅台', icon: 'book', module: 'reader' } },
  { path: '/audition', name: 'audition', component: () => import('@/views/Audition.vue'), meta: { title: '试听台', icon: 'activity', module: 'audition' } },
  { path: '/toland', name: 'toland', component: () => import('@/views/ToLand.vue'), meta: { title: '待落地', icon: 'toland' } },
  { path: '/history', name: 'history', component: () => import('@/views/DecisionHistory.vue'), meta: { title: '拍板历史', icon: 'history' } },
  { path: '/daily', name: 'daily', component: () => import('@/views/DailyOutput.vue'), meta: { title: '每日成果', icon: 'calendar' } },
  { path: '/insights', name: 'insights', component: () => import('@/views/Insights.vue'), meta: { title: '洞察', icon: 'chart' } },
  // 增强视图（MVP 后逐步填充；懒加载）
  { path: '/activity', name: 'activity', component: () => import('@/views/ActivityFeed.vue'), meta: { title: '活动流', icon: 'activity' } },
  { path: '/risk', name: 'risk', component: () => import('@/views/RiskPanel.vue'), meta: { title: '风险', icon: 'alertTri' } },
  { path: '/waves', name: 'waves', component: () => import('@/views/Waves.vue'), meta: { title: '波次', icon: 'layers' } },
  { path: '/acceptance', name: 'acceptance', component: () => import('@/views/AcceptanceMatrix.vue'), meta: { title: '验收', icon: 'checks' } },
  { path: '/collision', name: 'collision', component: () => import('@/views/Collision.vue'), meta: { title: '占用', icon: 'merge' } },
  { path: '/gantt', name: 'gantt', component: () => import('@/views/Gantt.vue'), meta: { title: '甘特', icon: 'gantt' } },
  { path: '/deps', name: 'deps', component: () => import('@/views/DependencyGraph.vue'), meta: { title: '依赖', icon: 'network' } },
  { path: '/search', name: 'search', component: () => import('@/views/SearchFilter.vue'), meta: { title: '搜索', icon: 'search' } },
  { path: '/cpu', name: 'cpu', redirect: '/sched' },
  { path: '/sched', name: 'sched', component: () => import('@/views/SchedConsole.vue'), meta: { title: '调度台', icon: 'cpu', module: 'cpu' } },
  // 成本监管:本机对话流水的真实 token 消耗(按天/按模型/主·子agent)+ 各卡施工成本登记(0901)。
  { path: '/cost', name: 'cost', component: () => import('@/views/CostMonitor.vue'), meta: { title: '成本', icon: 'coins', module: 'cost' } },
  { path: '/codex', name: 'codex', component: () => import('@/views/CodexPanel.vue'), meta: { title: 'Codex', icon: 'bot', module: 'codex' } },
  // 派活前先看这页:现在能同时开几张卡。纯规则算,不花额度。
  { path: '/parallel', name: 'parallel', component: () => import('@/views/ParallelPlan.vue'), meta: { title: '能同时派几张', icon: 'checks' } },
] satisfies ReadonlyArray<{ meta?: RouteMeta; [key: string]: unknown }>

const router = createRouter({
  history: createWebHashHistory(),
  routes,
})

router.beforeEach(async (to) => {
  const module = to.meta.module as ModuleId | undefined
  if (!module) return
  const store = useBoardStore()
  // main.ts 先安装 Pinia；首次直达扩展页要等设置读回，避免把已开启模块误判成默认关闭。
  if (!store.initialized) await store.loadModules()
  if (!store.modules[module]) return '/overview'
})

export default router
