/**
 * 把派单单渲染成给 Codex 的完整指令(CODEX-BRIDGE-DISPATCH,2026-09-01)。
 *
 * 【定位】本文件是整套派单桥**真正的资产**:命令怎么调、进程怎么起,换个工具就作废;
 * "一份指令要说清哪几件事"才是攒下来的东西。
 *
 * 【为什么不能只丢一句 goal 过去】Codex 每次 exec 都是**全新上下文**,它不加载 Claude 的
 * skill、不记得上一轮聊过什么。负责人 2026-08-14 已明确要求"派单指令必须是完整成品、
 * 可直接粘贴,禁止骨架让人组装"——同一条纪律对机器收单方只会更严:指令里没写的东西,
 * 对面就是不知道。
 *
 * 【与 AGENTS.md 的分工】仓库根的 AGENTS.md 是 Codex 自己会读的常驻须知(项目红线、
 * 三条铁规矩、CI 口径),本文件**不复制它的正文**,只做两件它做不到的事:
 * ①把"这一单"的施工面/禁区/验收断言讲死;②把完工契约(必须交什么形状的结论)讲死。
 * 复制正文会造成两份口径,改一处漏一处——这是 §11.10 明令禁止的。
 *
 * 【三条硬约束的由来】
 * · **禁止任何 git 写操作**:Codex 不 commit,产出就永远停在工作区,派单器一条
 *   `git diff --name-only` 就能看全它动了什么——禁区复核才有立足点。它一旦自己
 *   commit/stash,改动就藏进了对象库,复核直接失明。
 * · **不许自己拍板**:施工段零决策是项目红线;收单方遇到表内没有的选择题,正确动作是
 *   停下来写进 openQuestions,不是挑一个自己觉得对的做下去。
 * · **结论必须是结构化 JSON**:派单器要的是可判读的判决,不是一段散文。散文得靠人读,
 *   等于把省下来的额度又还回去了。
 */
import type { CodexTask } from './codex-contract'
import { acceptanceDescription } from './codex-contract'

const bullet = (items: string[], empty: string): string =>
  items.length === 0 ? '  (' + empty + ')' : items.map((s) => '  - ' + s).join('\n')

/** 完工标记:Codex 必须原样打印这一行,派单器据此判"它自认为跑完了"。 */
export const completionMarker = (slug: string): string => 'CODEX-DONE::' + slug

export const renderPrompt = (task: CodexTask): string => {
  const marker = completionMarker(task.slug)

  // 只描述「检查什么」,不给可执行命令 —— 理由见 codex-contract.ts 的 acceptanceDescription 头注。
  const acceptanceLines = task.acceptance
    .map((item) => {
      const must = item.required ? '必过' : '可选'
      return '  - [' + item.id + '] ' + must + ' · ' + acceptanceDescription(item) +
        (item.note ? '  // ' + item.note : '')
    })
    .join('\n')

  return [
    '你是本仓库的施工方之一。这是一份已经拍过板的施工单,照单干活,不要重新设计。',
    '',
    '## 开工前必读(按磁盘路径直接读,不要凭印象)',
    '  - AGENTS.md —— 本仓库给所有 AI 协作者的常驻须知(看板同步协议;这一单的看板登记由派单方代做,你不用跑看板 CLI)',
    '  - docs/开工须知-Codex派单.md —— 本仓库的派单口径,施工红线在第 3 节',
    '这两份里写的红线对你同等生效,尤其是:反阉割(不许为了跑通而砍功能/简化设计)、',
    '施工段零决策、界面上一律不用 emoji(web/scripts/check-no-emoji.cjs 会拦)、',
    '图标只用 web/src/icons 里现有的精灵(要新图标必须停下上报,不许自画)、',
    '颜色字面量只进 web/src/styles/base.css 的令牌与色站(组件里不出现颜色字面量)、',
    '本地设置走 localStorage 且读回时逐字段校验、一切动效尊重 prefers-reduced-motion。',
    '',
    '## 这一单是什么',
    '  任务号:' + task.taskId,
    '  标题:' + task.title,
    '  目标:' + task.goal,
    task.background ? '  背景:' + task.background : '',
    '',
    '## 施工面(只许动这些)',
    bullet(task.allowedPaths, '未圈定 —— 遇到这种工单直接停下上报'),
    '',
    '## 禁区(一个字都不许动)',
    bullet(task.forbiddenPaths, '无'),
    '',
    '## 明确不做的事(反阉割:这些是边界,不是可以顺手做掉的活)',
    bullet(task.nonGoals, '无'),
    '',
    '## 验收断言(派单器统一重跑 —— **这些你不要自己跑**)',
    '  下面是这一单干完之后要过的检查。它们**由派单器在你交活之后统一重跑**,',
    '  你说过了不算数、你自己跑过了也一样不算数 —— 所以不要在沙箱里去跑这些验收命令。',
    '  你多半也跑不动:工作区里的 web/node_modules 是指向主工位的目录联接,沙箱会拦住它的写入,',
    '  vue-tsc / vite 起不来。硬试的代价极高(别的项目实测一单为此烧掉 512 万 token,真实产出只有 32 行)。',
    '  所以结论里的 acceptanceResults 一律填 ran=false —— 那是本工单的要求,不是失职。',
    '  (这不妨碍你用别的轻量办法自查,比如读代码、跑一小段 node -e 验算;',
    '   禁的只是去跑上面这些验收命令。)',
    acceptanceLines,
    '',
    task.expectArtifacts.length > 0
      ? '## 完工必须存在的产物(派单器会逐个查文件在不在)\n' + bullet(task.expectArtifacts, '无')
      : '',
    '',
    '## 三条硬约束(违反任何一条,这一单直接判否)',
    '  1. **不许做任何 git 写操作**:不 commit、不 push、不 checkout/switch、不 reset、',
    '     不 merge/rebase、不 stash、不建删分支。改动就停在工作区,由派单器统一收。',
    '     (只读的 git status / diff / log 随便用。)',
    '  2. **不许自己拍板**:遇到施工面里没写清楚的选择题、与设计冲突的地方、需要砍功能',
    '     才能跑通的情况 —— 停下,把问题写进结论的 openQuestions,status 交 blocked。',
    '     不要挑一个你觉得对的做下去。',
    '  3. **不许改工单目录 .codex/jobs/**:那是你自己的工单和判决落盘处。',
    '',
    '## 干完之后必须做的两件事',
    '  1. 原样打印这一行(一个字符都不能差):',
    '     ' + marker,
    '  2. 你的**最后一条消息**必须是一个 JSON 对象,符合下发的 output schema。',
    '     summary 是看板直接给不懂代码的负责人看的中文短段落,200 字以内。',
    '     只回答三件事:"这活是干什么的、干完了没有、有没有需要人处理的问题"。',
    '     先把任务目标翻成人话,不要照抄带技术词的标题或目标;完成情况直说"已完成、',
    '     只完成一部分或还没完成",没有需要人处理的问题也要明确说"不需要人处理"。',
    '     不要写文件名、路径、命令、测试编号、错误码、代码符号、英文缩写或其他技术术语;',
    '     技术细节放进 changedFiles、acceptanceResults 和 blockers,不要塞进 summary。',
    '     acceptanceResults 里逐条如实填 —— **跑没跑过就写 ran,过没过写 passed,',
    '     没跑就写 ran=false,不许猜**。派单器会自己重跑复核,谎报只会被当场抓出来。',
    '',
    '现在开始干活。',
  ]
    .filter((line) => line !== '')
    .join('\n')
}
