// 全部视图路由级懒加载（() => import() 自动分 chunk）：首屏只含入口 + Overview，
// echarts 仅存在于 Gantt / DependencyGraph 的独立 chunk，绝不进首屏（R8）。
// hash 历史：dist 被 server 从任意子路径静态托管、刷新不 404、双击可开。
import { createRouter, createWebHashHistory } from 'vue-router'

const routes = [
  { path: '/', redirect: '/overview' },
  { path: '/overview', name: 'overview', component: () => import('@/views/Overview.vue'), meta: { title: '总览', icon: '🏠' } },
  { path: '/kanban', name: 'kanban', component: () => import('@/views/Kanban.vue'), meta: { title: '看板', icon: '📋' } },
  { path: '/approvals', name: 'approvals', component: () => import('@/views/ApprovalCenter.vue'), meta: { title: '待拍板', icon: '❓' } },
  { path: '/toland', name: 'toland', component: () => import('@/views/ToLand.vue'), meta: { title: '待落地', icon: '🚀' } },
  { path: '/history', name: 'history', component: () => import('@/views/DecisionHistory.vue'), meta: { title: '拍板历史', icon: '📜' } },
  // 增强视图（MVP 后逐步填充；懒加载）
  { path: '/activity', name: 'activity', component: () => import('@/views/ActivityFeed.vue'), meta: { title: '活动流', icon: '📜' } },
  { path: '/risk', name: 'risk', component: () => import('@/views/RiskPanel.vue'), meta: { title: '风险', icon: '⚠️' } },
  { path: '/waves', name: 'waves', component: () => import('@/views/Waves.vue'), meta: { title: '波次', icon: '🌊' } },
  { path: '/acceptance', name: 'acceptance', component: () => import('@/views/AcceptanceMatrix.vue'), meta: { title: '验收', icon: '🚦' } },
  { path: '/collision', name: 'collision', component: () => import('@/views/Collision.vue'), meta: { title: '占用', icon: '💥' } },
  { path: '/gantt', name: 'gantt', component: () => import('@/views/Gantt.vue'), meta: { title: '甘特', icon: '📅' } },
  { path: '/deps', name: 'deps', component: () => import('@/views/DependencyGraph.vue'), meta: { title: '依赖', icon: '🕸️' } },
  { path: '/search', name: 'search', component: () => import('@/views/SearchFilter.vue'), meta: { title: '搜索', icon: '🔍' } },
]

const router = createRouter({
  history: createWebHashHistory(),
  routes,
})

export default router
