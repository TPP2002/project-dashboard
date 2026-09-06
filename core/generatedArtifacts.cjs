'use strict';
/**
 * generatedArtifacts.cjs —— 判断 fileScope(文件范围)里的一条路径是不是「自动生成物 / 人人都会碰的共改文件」。
 *
 * 【为什么需要这个判据】fileScope 这个字段不只是给人看的,它同时被三处**判断**吃掉:
 *   ① 并行清单(server/parallelPlan.cjs):哪几张卡可以同时派 —— 文件范围重叠 = 判定会撞车,只放一张;
 *   ② 占用防撞页(web/src/views/Collision.vue):同一条文件范围出现在多张卡里 = 标红为冲突;
 *   ③ 建卡/认领(cli/commands.cjs):录进去之后就一直按上面两条参与判断。
 * 一旦有人往 fileScope 里填了「谁干活都会碰」的生成物(最典型:看板 render-index 自己吐出来的
 * docs/INDEX-自动生成.md),这三处判断就同时失真:两张八竿子打不着的卡——一张改引擎、一张改 UI——
 * 只因为都写了一句文档,就被判成同区、只能串行派;施工中的卡还能凭这一条把整组候选卡按住。
 * 2026-09-03 实证:rogue 板上 docs/INDEX-自动生成.md 同时挂在 7 张卡的 fileScope 里(卡
 * BOARD-FILESCOPE-INDEX-POLLUTION)。
 *
 * 【处置口径】不替用户删字段——fileScope 里留着这行对人是有信息量的(这张卡确实会动到它);
 * 只在**判撞车**时把它当空气,并在建卡/认领当场提醒一句别填。生成物的冲突本来也不靠人工串行解决:
 * 重跑一次生成脚本就好。
 *
 * 【为什么故意不把 build/ 算进来】肉鸽仓真有 src/engine/build/ 这个源码目录(4 张卡的 fileScope
 * 指向它)。把 build 当生成物会误伤真源码——判据宁可漏判(顶多少省一次串行),不可误判
 * (会让两个人真撞在同一个文件上)。
 *
 * 【单一真相源】前端不许另抄一份:vite 用 toEsmSource() 把本文件内联成虚拟模块
 * 'virtual:generated-artifacts'(同 boardSchema 的做法),CLI / server 直接 require。
 */

/** 路径按「已归一成正斜杠、去掉开头 ./」的形式来匹配。 */
const GENERATED_ARTIFACT_PATTERNS = [
  /(^|\/)[^/]*自动生成[^/]*(\/|$)/,                          // 看板 render-index 产物:docs/INDEX-自动生成.md
  /(^|\/)\.dashboard\/(board\.json|INDEX\.md)$/,             // 看板自己的板数据与索引(每张卡都在改)
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/,  // 装个包就整片变的锁文件
  /(^|\/)(node_modules|dist|coverage)(\/|$)/,                // 依赖 / 构建产物 / 覆盖率报告
];

/**
 * 这条 fileScope 是不是自动生成物?
 *
 * 历史数据里有人把多个路径用逗号塞进同一条(如 "CLAUDE.md,docs/INDEX-自动生成.md"),
 * 这种混装条**整条**里只要有一个手写文件就照旧参与判撞车——判据宁可漏判不可误判:
 * 漏判顶多少省一次串行,误判会把真会撞的文件从冲突判断里摘掉。
 *
 * @param {string} scopeEntry fileScope 里的一条(可以是 glob,可以是 Windows 反斜杠路径)
 * @returns {boolean}
 */
function isGeneratedArtifact(scopeEntry) {
  if (typeof scopeEntry !== 'string') return false;
  const pieces = scopeEntry.split(',').map((s) => s.trim().replace(/\\/g, '/').replace(/^\.\//, '')).filter(Boolean);
  if (!pieces.length) return false;
  return pieces.every((p) => GENERATED_ARTIFACT_PATTERNS.some((re) => re.test(p)));
}

/**
 * 生成给前端用的 ESM 源码(vite 虚拟模块 'virtual:generated-artifacts' 的内容)。
 * 正则与函数体都直接取自本文件,改这里前端跟着变,不存在两份判据对不上的可能。
 */
function toEsmSource() {
  return [
    '// 由 core/generatedArtifacts.cjs 经 vite 虚拟模块内联生成,勿手改。',
    `export const GENERATED_ARTIFACT_PATTERNS = [${GENERATED_ARTIFACT_PATTERNS.map(String).join(', ')}]`,
    `export const isGeneratedArtifact = ${String(isGeneratedArtifact)}`,
    '',
  ].join('\n');
}

module.exports = { GENERATED_ARTIFACT_PATTERNS, isGeneratedArtifact, toEsmSource };
