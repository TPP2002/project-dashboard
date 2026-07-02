'use strict';
/**
 * packaging/demo-seed.cjs —— 造一套「通用演示数据」（不含任何真实私有项目）。
 * 用于 README 截图 / 让访客一键看到丰富看板。写入隔离的 DASHBOARD_HOME，
 * 绝不碰用户真实 registry。两个虚构项目：闪购电商 App + 个人博客。
 *
 * 用法：node packaging/demo-seed.cjs <demoHome目录>
 */
const fs = require('node:fs');
const path = require('node:path');
const { assertValid } = require('../core/boardSchema.cjs');

const home = path.resolve(process.argv[2] || path.join(require('os').tmpdir(), 'dash-demo'));
const boardsDir = path.join(home, 'boards');
fs.mkdirSync(boardsDir, { recursive: true });

const NOW = '2026-07-02T10:00:00Z';
function T(o) {
  return Object.assign({
    id: o.id, title: o.title, description: o.description || '', status: o.status,
    percent: o.percent != null ? o.percent : (o.status === '已完工' ? 100 : 0),
    wave: o.wave || 0,
    dates: o.dates || { design: '2026-06-10', start: null, done: null },
    gitBranch: o.gitBranch || [], worktree: [], prNumbers: o.prNumbers || [], commitShas: o.commitShas || [],
    fileScope: o.fileScope || [], forbiddenZones: [], docs: o.docs || [],
    decisions: o.decisions || [],
    deps: Object.assign({ dependsOn: [], blockedBy: [], relatedTasks: [] }, o.deps || {}),
    next: o.next,
    tests: o.tests, typecheck: o.typecheck,
  });
}

// ---------- 项目1：闪购电商 App ----------
const shop = {
  schemaVersion: '1.0',
  project: { id: 'shopfast', name: '闪购 · 电商 App', mainRepo: 'D:\\code\\shopfast', forbiddenZones: ['src/legacy/**'], createdAt: '2026-05-01T09:00:00Z', updatedAt: NOW },
  tasks: [
    T({ id: 'FEAT-1', title: '登录鉴权重构（JWT → Session）', status: '已完工', wave: 1, percent: 100, dates: { design: '2026-05-02', start: '2026-05-03', done: '2026-05-09' }, gitBranch: ['feat/auth'], prNumbers: [12], commitShas: ['a1b2c3d', 'e4f5a6b'], tests: { total: 24, passed: 24 }, typecheck: true }),
    T({ id: 'FEAT-2', title: '购物车结算流程', status: '施工中', wave: 1, percent: 60, dates: { design: '2026-06-01', start: '2026-06-20', done: null }, gitBranch: ['feat/checkout'], next: '接支付网关沙箱联调', tests: { total: 18, passed: 11 }, typecheck: true }),
    T({ id: 'BUG-3', title: '支付回调偶发重复扣款', status: '待拍板', wave: 1, percent: 30, dates: { design: '2026-06-25', start: '2026-06-28', done: null }, gitBranch: ['fix/double-charge'],
       decisions: [{ id: 'd1', question: '并发扣款防重，用哪种锁方案？', options: ['乐观锁（版本号 CAS）', 'Redis 分布式锁', '数据库悲观锁 SELECT FOR UPDATE'], recommended: '乐观锁（版本号 CAS）', answer: null,
         background: '支付回调在高并发下偶发出现同一笔订单被重复扣款：网关重试叠加回调乱序，导致同一订单短时间内两次进入结算逻辑。订单表已有 version 字段，日均回调约 5 万次、峰值 QPS 约 300，需要一个可靠的防重机制。',
         optionPros: {
           '乐观锁（版本号 CAS）': '改动最小、无新增中间件依赖，冲突时失败重试即可；缺点是极端高冲突下重试次数会上升。',
           'Redis 分布式锁': '强互斥、跨实例可靠；缺点是引入 Redis 单点与锁超时/续期复杂度，多一层运维成本。',
           '数据库悲观锁 SELECT FOR UPDATE': '语义直观、强一致；缺点是高并发下行锁堆积、吞吐下降、存在死锁风险。' },
         recommendReason: '乐观锁改动最小、无额外中间件依赖，回调冲突概率低、失败重试即可；分布式锁会引入 Redis 单点与锁超时的复杂度，悲观锁在高并发下易造成行锁堆积。' }] }),
    T({ id: 'FEAT-4', title: '首页性能优化（懒加载 + CDN）', status: '已拍板', wave: 2, percent: 0, dates: { design: '2026-06-26', start: null, done: null },
       decisions: [{ id: 'd2', question: '首屏渲染：SSR 还是 CSR + 骨架屏？', options: ['SSR（Nuxt）', 'CSR + 骨架屏', 'SSG 预渲染'], recommended: 'CSR + 骨架屏', answer: 'CSR + 骨架屏', decidedAt: '2026-06-30', landed: false,
         background: '首页首屏加载偏慢、白屏时间长，影响转化率。团队当前是纯前端 CSR、无 SSR 服务端运维经验；页面数据个性化程度高、缓存命中率有限，需要在改造成本与首屏体验之间取舍。',
         optionPros: {
           'SSR（Nuxt）': '首屏最快、SEO 最好；缺点是需要 Node 服务端运维、改造成本高。',
           'CSR + 骨架屏': '改造成本最低、感知速度明显改善；缺点是首屏真实数据仍稍慢。',
           'SSG 预渲染': '纯静态、最快；缺点是不适合个性化/实时数据页面。' },
         recommendReason: '团队无 SSR 运维经验，骨架屏能以最小成本改善首屏感知速度，后续再评估是否上 SSR。' }] }),
    T({ id: 'FEAT-5', title: '商品搜索（接入 Elasticsearch）', status: '待开工', wave: 2, dates: { design: '2026-06-28', start: null, done: null }, deps: { dependsOn: ['FEAT-2'] } }),
    T({ id: 'FEAT-6', title: '优惠券与满减系统', status: '未开工', wave: 3 }),
    T({ id: 'BUG-7', title: 'iOS 端商品图旋转错乱', status: '已完工', wave: 1, percent: 100, dates: { design: '2026-05-12', start: '2026-05-12', done: '2026-05-13' }, prNumbers: [15], commitShas: ['bb1c2d3'] }),
    T({ id: 'FEAT-8', title: '订单履约状态机', status: '施工中', wave: 2, percent: 40, dates: { design: '2026-06-15', start: '2026-06-27', done: null }, gitBranch: ['feat/fulfillment'], next: '补充退款分支状态', deps: { relatedTasks: ['FEAT-2'] } }),
    T({ id: 'CHORE-9', title: 'CI 流水线加依赖缓存', status: '已完工', wave: 1, percent: 100, dates: { design: '2026-05-20', start: '2026-05-20', done: '2026-05-21' }, prNumbers: [9], commitShas: ['c9d0e1f'] }),
    T({ id: 'FEAT-10', title: '会员积分体系', status: '暂缓', wave: 3, dates: { design: '2026-06-10', start: null, done: null }, next: '等运营方案定稿再开工' }),
    T({ id: 'BUG-11', title: '秒杀库存超卖', status: '收官', wave: 1, percent: 90, dates: { design: '2026-06-05', start: '2026-06-22', done: null }, gitBranch: ['fix/oversell'], prNumbers: [21], tests: { total: 12, passed: 12 }, typecheck: true }),
    T({ id: 'SEC-13', title: '越权访问（IDOR）修复', status: '待拍板', wave: 1, percent: 20, dates: { design: '2026-06-29', start: '2026-06-30', done: null },
       decisions: [{ id: 'd3', question: '修复范围：只补这次接口，还是重构全站鉴权中间件？', options: ['只补涉事接口', '重构全站鉴权中间件'], recommended: '只补涉事接口', answer: null,
         background: '安全扫描发现 3 个接口存在 IDOR（越权直接引用对象 id），可越权查看他人订单详情。全站约 80 个接口、鉴权逻辑散落在各 controller 中，缺少统一的资源归属校验中间件，同类隐患可能不止这三处。',
         optionPros: {
           '只补涉事接口': '快速止血、当天可上线、风险可控；缺点是治标，同类漏洞可能再现。',
           '重构全站鉴权中间件': '一次性根治、统一资源归属校验；缺点是改动面大、回归风险高、周期长。' },
         recommendReason: '先止血涉事接口、当天即可上线；全站中间件重构风险大、战线长，宜另立任务排期推进，避免本次修复被拖长。' }] }),
    T({ id: 'FEAT-14', title: '大促压测与限流', status: '压轴', wave: 3, dates: { design: '2026-06-30', start: null, done: null }, deps: { dependsOn: ['FEAT-8', 'BUG-11'] } }),
  ],
  activity: [
    { type: 'done', author: 'claude', text: '完工 FEAT-1：登录鉴权重构（24/24 测试通过）', taskId: 'FEAT-1', ts: '2026-05-09T16:20:00Z' },
    { type: 'claim', author: 'cursor', text: '认领 FEAT-8：订单履约状态机', taskId: 'FEAT-8', ts: '2026-06-27T09:05:00Z' },
    { type: 'pending', author: 'claude', text: '登记待拍板 BUG-3#d1：并发扣款锁方案', taskId: 'BUG-3', ts: '2026-06-28T11:30:00Z' },
    { type: 'decide', author: '你', text: '拍板 FEAT-4#d2：首屏用「CSR + 骨架屏」', taskId: 'FEAT-4', ts: '2026-06-30T14:10:00Z' },
    { type: 'progress', author: 'claude', text: 'FEAT-2 进度 60%：下一步接支付网关沙箱', taskId: 'FEAT-2', ts: '2026-07-01T10:45:00Z' },
    { type: 'pending', author: 'gemini', text: '登记待拍板 SEC-13#d3：越权修复范围', taskId: 'SEC-13', ts: '2026-07-01T15:00:00Z' },
  ],
};

// ---------- 项目2：个人博客 ----------
const blog = {
  schemaVersion: '1.0',
  project: { id: 'blog', name: '个人博客 / 内容站', mainRepo: 'D:\\code\\blog', forbiddenZones: [], createdAt: '2026-06-01T09:00:00Z', updatedAt: NOW },
  tasks: [
    T({ id: 'B1', title: '迁移到静态生成（SSG）', status: '已完工', wave: 1, percent: 100, dates: { design: '2026-06-02', start: '2026-06-03', done: '2026-06-06' }, prNumbers: [3], commitShas: ['f1e2d3c'] }),
    T({ id: 'B2', title: '深色模式', status: '已完工', wave: 1, percent: 100, dates: { design: '2026-06-06', start: '2026-06-07', done: '2026-06-08' }, commitShas: ['0a1b2c3'] }),
    T({ id: 'B3', title: '评论系统（接入 Giscus）', status: '施工中', wave: 2, percent: 50, dates: { design: '2026-06-20', start: '2026-06-28', done: null }, gitBranch: ['feat/comments'], next: 'OAuth 回调域名配置' }),
    T({ id: 'B4', title: 'RSS 与站点地图', status: '待开工', wave: 2 }),
    T({ id: 'B5', title: '文章全文搜索', status: '待拍板', wave: 2, percent: 10,
       decisions: [{ id: 'bd1', question: '搜索用本地索引还是托管服务？', options: ['Pagefind（本地静态索引）', 'Algolia（托管）'], recommended: 'Pagefind（本地静态索引）', answer: null,
         background: '博客是纯静态站（SSG），想加全文搜索但没有后端服务。文章约 200 篇且持续增长；希望零后端、免费、不引入外部数据依赖，同时保证搜索响应速度与离线可用。',
         optionPros: {
           'Pagefind（本地静态索引）': '零后端、免费、数据不出站；缺点是索引随文章增多而变大、需构建时生成。',
           'Algolia（托管）': '搜索体验好、开箱即用；缺点是免费额度有限、内容需同步到第三方、有外部依赖。' },
         recommendReason: 'Pagefind 零后端、免费、契合 SSG 构建流程；Algolia 免费额度有限且需要把全部内容同步到第三方服务。' }] }),
    T({ id: 'B6', title: '图片自动压缩流水线', status: '未开工', wave: 3 }),
  ],
  activity: [
    { type: 'done', author: 'claude', text: '完工 B1：迁移到静态生成', taskId: 'B1', ts: '2026-06-06T18:00:00Z' },
    { type: 'progress', author: 'codex', text: 'B3 进度 50%：评论系统接入中', taskId: 'B3', ts: '2026-07-01T09:30:00Z' },
  ],
};

function writeBoard(b) {
  b.activity = b.activity.map((a, i) => Object.assign({ id: 'a' + (i + 1) }, a));
  assertValid(b);
  const p = path.join(boardsDir, b.project.id + '.json');
  fs.writeFileSync(p, JSON.stringify(b, null, 2));
  return p;
}
const shopPath = writeBoard(shop);
const blogPath = writeBoard(blog);

const registry = {
  schemaVersion: '1.0',
  projects: {
    shopfast: { name: shop.project.name, mainRepo: shop.project.mainRepo, board: shopPath },
    blog: { name: blog.project.name, mainRepo: blog.project.mainRepo, board: blogPath },
  },
};
fs.writeFileSync(path.join(home, 'registry.json'), JSON.stringify(registry, null, 2));
console.log('✔ 演示数据已生成:', home);
console.log('  项目: shopfast(' + shop.tasks.length + ' 任务) + blog(' + blog.tasks.length + ' 任务)');
console.log('  待拍板: 3 条(BUG-3#d1 / SEC-13#d3 / B5#bd1)');
