'use strict';
/**
 * help.cjs —— 逐命令帮助(AUD-CLI-BRIEF-AND-HELP,审计 §4-A1)。
 *
 * 【病根】全局 help 只罗列命令名;`pending --help` 会被 need() 当成"缺参数 --project"报错。
 * 而 AGENTS.md 明写让施工方去看 `pending --help` —— 照着做必失败,白跑一整轮。
 * 【治法】帮助是一张表,不是散落在各命令里的 need() 字符串:一条命令一条,含
 * 一句话 / 用法 / 参数 / 示例 / 退出码。test/cliHelp.test.cjs 拿 index.cjs 的注册表逐条比对,
 * 新增命令漏写帮助会当场红。
 */

/** 所有命令共有的 flag,不必每条帮助重复一遍。 */
const GLOBAL_FLAGS = [
  ['--project <id>', '认哪块板。在项目仓里跑可省略(按当前 git 仓自动认;一个仓登记给多个项目时必须显式写)'],
  ['--author <身份>', '这次动作记在谁头上,进活动流。默认 cli / 分支名'],
  ['--json', '机读输出。写命令只回 {ok,id,status,percent,changed[]}'],
  ['--registry <path>', '换一份注册表。测试隔离用,日常不传'],
];

/** 退出码是全局约定(index.cjs 的 dispatch 决定),每条帮助都附一份。 */
const EXIT_CODES = [
  ['0', '成功'],
  ['1', '命令自己拒了:参数不合格 / 状态机不许这么迁移 / 建卡机器闸拦下'],
  ['2', '没有这条命令'],
  ['3', '这条命令还没实现(实现文件缺失或没导出)'],
];

/** 全局 help 的分组:先给天天用的,装机维护的沉到后面。 */
const GROUPS = [
  ['开工与同步（最常用）', ['protocol', 'brief', 'claim', 'progress', 'pending', 'decide', 'done', 'note', 'request-info']],
  ['查询', ['list', 'show', 'inbox', 'cost', 'precheck']],
  ['卡的生命周期', ['add', 'unclaim', 'park', 'unpark', 'block', 'cancel', 'reopen',
    'edit', 'set', 'mark-landed', 'sync-progress']],
  ['装机与维护', ['register', 'enroll', 'hooks-install', 'hooks-global', 'hooks-trunk-guard',
    'release', 'claim-check', 'doctor', 'sync-from-git', 'cleanup', 'docs-audit']],
  ['导入导出', ['import', 'backfill', 'onboard', 'render-index', 'snapshot', 'archive-activity']],
];

const COMMANDS = {
  // ——— 开工与同步 ———
  protocol: {
    summary: '生成看板协议卡（与帮助同源的用法、状态行为、硬规则与正确示例）',
    usage: 'protocol [--project <id>] [--format md|json]',
    args: [
      ['--format md|json', '默认 md（≤60 行）；json 输出结构化协议对象'],
      ['--project <id>', '可选；省略时只认唯一命中，认不出或共仓歧义时用 <项目id> 占位符'],
    ],
    examples: ['protocol', 'protocol --project myproj --format json'],
    notes: [
      '动代码前先 protocol 拿规矩，再 brief <卡号> 拿任务书，随后 claim。',
      '只读生成，不写看板；无需先注册项目，认不出项目也不报错。',
      '--format json 返回协议本身；全局 --json 则封装为 {ok,text}。',
    ],
  },
  brief: {
    summary: '一条命令拿全开工信息（人话标题/技术说明/文件域/依赖/待拍板/已拍板答案/文档）',
    usage: 'brief <卡号> --project <id>',
    args: [
      ['<卡号>', '要开工的那张卡'],
      ['--project <id>', '哪块板'],
    ],
    examples: ['brief FEAT-12 --project myproj'],
    notes: [
      '先 protocol 拿规矩，再读这份任务书，确认要干什么、能不能动手。',
      '卡上还有没答的待拍板问题时，任务书顶部会写「禁止开工」——先让负责人拍板。',
      '`claim --brief` 认领的同时打印同一份；`inbox --tid` 用的也是同一个生成器。',
    ],
  },
  claim: {
    summary: '认领一张卡（动代码之前的必做动作，pre-commit 闸门认这个）',
    usage: 'claim <卡号> --project <id> --branch <分支> [--scope <glob>...] [--brief]',
    args: [
      ['<卡号>', '要认领的卡'],
      ['--branch <分支>', '本次施工的分支名，可重复'],
      ['--scope <glob>', '这张卡会改哪些文件，可重复。看板靠它算"现在能同时派几张"'],
      ['--brief', '认领后顺手打印完整开工任务书（= brief <卡号>）'],
    ],
    examples: [
      'claim FEAT-12 --project myproj --branch feat/login',
      'claim FEAT-12 --project myproj --branch feat/login --scope "src/auth/*" --brief',
    ],
    notes: [
      '只能从 未开工/待开工/可复工/待拍板/已拍板/施工中 迁到 施工中；已完工/已作废的卡要先 `reopen`。',
      '卡还不在板上就先 add。不 claim 就 commit 会被闸门拒。',
    ],
  },
  progress: {
    summary: '回写进度与下一个里程碑',
    usage: 'progress <卡号> --project <id> --percent <0-100> [--next <下一步>] [--tests <总/过/必败>] [--typecheck <true|false>]',
    args: [
      ['--percent <n>', '0–100 的整数'],
      ['--next <文本>', '下一步要做什么，一句话'],
      ['--tests <t/p/m>', '测试总数/通过数/必败先行数，如 120/118/3'],
      ['--typecheck', 'true 表示类型检查已过'],
    ],
    examples: ['progress FEAT-12 --project myproj --percent 60 --next "接线到入口，然后补回归测试"'],
    notes: ['装了 TodoWrite 钩子后进度会自动同步，手动 progress 用来补里程碑说明。'],
  },
  pending: {
    summary: '登记一个要负责人拍板的问题（必须给全背景/各选项利弊/推荐理由三件套）',
    usage: 'pending <卡号> --project <id> --json-file <路径>  或  '
      + 'pending <卡号> --project <id> --q <问题> --opt <选项>... --rec <推荐> --background <背景> --pros-<选项> <利弊> --reason <推荐理由> [--strict]',
    args: [
      ['--json-file <路径>', '从文件读整块 JSON（首选：字段多，命令行转义容易出错；PowerShell 下 heredoc 也不好使）'],
      ['--json', '同上，但从 stdin 读'],
      ['--q <问题>', '一句大白话问题'],
      ['--opt <选项>', '候选答案，至少两个，可重复'],
      ['--rec <选项>', '推荐哪一个，必须在 --opt 里'],
      ['--background <文本>', '背景，≥60 字：什么场景、什么问题、要做什么、为什么重要'],
      ['--pros-<选项> <文本>', '该选项的【好处】【代价】，每个 ≥20 字，每个选项都要有'],
      ['--reason <文本>', '为什么推荐它，≥30 字'],
      ['--did <dN>', '决策编号，默认按顺序自动生成'],
      ['--strict', '禁止自定义答案（默认允许负责人写自己的答案）'],
    ],
    examples: [
      'pending FEAT-12 --project myproj --json-file pending.json',
      'pending FEAT-12 --project myproj --q "登录失败要不要锁账号?" --opt "锁" --opt "不锁" --rec "锁" --background "..." --pros-锁 "..." --pros-不锁 "..." --reason "..."',
    ],
    notes: [
      '三件套是硬校验：缺字段或太短当场拒收，报错里会附一份可直接填的模板 JSON。',
      '判据：零上下文的人只看这一条就能独立拍板。',
    ],
  },
  decide: {
    summary: '拍板：给某条待拍板问题填答案',
    usage: 'decide <卡号> --project <id> --did <dN> --answer <答案> [--no-promote]',
    args: [
      ['--did <dN>', '哪条决策'],
      ['--answer <文本>', '答案。不在选项内时要求这条决策允许自定义'],
      ['--no-promote', '答完最后一条也不把卡从 待拍板 推到 已拍板'],
    ],
    examples: ['decide FEAT-12 --project myproj --did d1 --answer "锁"'],
    notes: ['默认会推进状态：全部决策都答完且卡正挂在「待拍板」时自动转「已拍板」。'],
  },
  done: {
    summary: '收官：卡转已完工，登记 PR 与提交号',
    usage: 'done <卡号> --project <id> [--pr <n>...] [--commit <sha>...] [--collect]',
    args: [
      ['--pr <n>', 'PR 号，可重复'],
      ['--commit <sha>', '提交哈希，可重复。长短哈希会按前缀归并'],
      ['--collect', '转「收官」而不是「已完工」'],
    ],
    examples: ['done FEAT-12 --project myproj --pr 42 --commit a1b2c3d'],
    notes: [
      '收官时顺手把本卡「已拍板却没标落地」的决策一起标掉（`--collect` 不做这件事）。',
      '写完立刻 `show <卡号>` 复核：多对话并行时后写的可能把先写的整份盖掉。',
    ],
  },
  note: {
    summary: '往活动流写一条留言（可挂在某张卡上，也可只挂项目）',
    usage: 'note <卡号> --project <id> --text <文本>  或  note --project <id> --text <文本>',
    args: [
      ['<卡号> / --task <卡号>', '两种写法等价，挂在哪张卡上。都不写就是项目级留言'],
      ['--text <文本>', '留言正文'],
      ['--from <身份>', 'human 固定署名为「负责人」，其它值原样作为署名；不传则沿用 --author'],
    ],
    examples: [
      'note FEAT-12 --project myproj --text "施工方=自干；撞车预警见分支说明"',
      'note --project myproj --text "今天只做批次一"',
    ],
    notes: ['卡号写错会被引用完整性校验在写盘前拦下。'],
  },
  'request-info': {
    summary: '要求补齐未答决策的背景、各选项利弊或推荐理由',
    usage: 'request-info <卡号> --project <id> --did <dN> --missing <字段列表> [--author <身份>]',
    args: [
      ['<卡号>', '要补齐拍板信息的卡'],
      ['--did <dN>', '本卡尚未回答的决策编号'],
      ['--missing <字段列表>', 'background、optionPros、recommendReason 的非空子集，用逗号分隔'],
      ['--author <身份>', '活动署名，默认「负责人」'],
    ],
    examples: ['request-info FEAT-12 --project myproj --did d1 --missing background,optionPros'],
    notes: ['写活动并记录 infoRequestedAt；不改答案或状态。已答决策与非法字段会被拒绝。'],
  },

  // ——— 查询 ———
  list: {
    summary: '列出任务（默认隐藏已完工、只给人话标题）',
    usage: 'list --project <id> [--all] [--status <状态>] [--wave <n>] [--brief] [--fields a,b,c]',
    args: [
      ['--all', '连已完工一起列'],
      ['--status <状态>', '只看某个状态。点名了就不再套默认隐藏'],
      ['--wave <n>', '只看某个波次'],
      ['--brief', '只给 卡号/状态/进度'],
      ['--fields a,b', '自选列。支持别名 pct/branch/plain/spec/model/next/pr/scope 与点路径 dates.done'],
    ],
    examples: [
      'list --project myproj',
      'list --project myproj --status 施工中',
      'list --project myproj --fields id,status,branch,scope',
    ],
    notes: ['默认视图不含技术说明全文（那是给模型看的详细说明，可达两千字）；要全文用 `show <卡号> --full`。'],
  },
  show: {
    summary: '看一张卡的精简卡片，或列出全板待拍板',
    usage: 'show <卡号> --project <id> [--full]  或  show --pending --project <id>',
    args: [
      ['<卡号>', '要看的卡'],
      ['--full', '给整卡 JSON（一个字段不落）'],
      ['--pending', '不看单卡，列出全板还没答的待拍板问题'],
    ],
    examples: ['show FEAT-12 --project myproj', 'show FEAT-12 --project myproj --full', 'show --pending --project myproj'],
    notes: ['要开工请用 `brief <卡号>`：那份才带文件域、依赖状态和已拍板要落地的答案。'],
  },
  inbox: {
    summary: '读看板接单：列出有已拍板待落地决策的卡，或打印某张卡的完整任务书',
    usage: 'inbox --project <id> [--tid <卡号>] [--limit <n>] [--all]',
    args: [
      ['--tid <卡号>', '打印这张卡的完整任务书（= brief + 落地流程）'],
      ['--limit <n>', '列表态最多列几张，默认 30'],
      ['--all', '列表态全列，不封顶'],
    ],
    examples: ['inbox --project myproj', 'inbox --project myproj --tid FEAT-12'],
    notes: [
      '不带 --tid 时只给 卡号 + 人话标题 + 待落地条数，够挑一张就行；新拍的板排前面。',
      '列表态默认只列一屏——总数照实报，剩下的用 --all 看。',
    ],
  },
  cost: {
    summary: '登记这张卡花了哪些 agent / 模型档',
    usage: 'cost <卡号> --project <id> --agents "<模型:个数,…>" [--tokens <n>] [--note <一句话>]',
    args: [
      ['--agents <文本>', '如 "sonnet:3,opus:1"；纯主对话施工写 "main:1"'],
      ['--tokens <n>', '大致 token 数，非负整数'],
      ['--note <文本>', '一句话备注'],
    ],
    examples: ['cost FEAT-12 --project myproj --agents "main:1,sonnet:2" --tokens 120000'],
    notes: [],
  },
  precheck: {
    summary: '开工三查：环境新鲜度 / 看板占用 / 正本必读清单（只读）',
    usage: 'precheck --project <id> [--repo <工位路径>] [--no-fetch]',
    args: [
      ['--repo <路径>', '要查的工位，默认当前代码检出'],
      ['--no-fetch', '跳过 git fetch（离线时用）'],
    ],
    examples: ['precheck --project myproj'],
    notes: ['三查只是开工的前半截：还要建分支推远程 + claim 才算认领完成。'],
  },

  // ——— 卡的生命周期 ———
  add: {
    summary: '新建一张卡（必须同时给技术说明、人话标题、建议档位）',
    usage: 'add <卡号> --project <id> --title <技术说明> --plain-title <人话标题> --model <档位> [--scope <glob>...] [--status <状态>] [--wave <n>] [--desc <一句话>]\n'
      + 'add --project <id> --json-file <清单.json>   # 一份清单建一批',
    args: [
      ['<卡号>', '大写字母/数字/中划线，如 FEAT-12'],
      ['--title <文本>', '给模型看的技术详细说明（必填）'],
      ['--plain-title <文本>', '给负责人看的一句人话，20~35 字，禁文件名/函数名/缩写（必填，机器闸）'],
      ['--model <档位>', '建议施工档位，≤40 字符，如 "opus·中"（必填，机器闸）'],
      ['--scope <glob>', '这张卡会改哪些文件，可重复。拿不准就别填，填错比不填更坏'],
      ['--status <状态>', '初始状态，默认 未开工'],
      ['--wave <n>', '波次。施工中新冒出来的卡一律留 0，别继承父卡的波次'],
      ['--desc <文本>', '一句话补充说明'],
      ['--json-file <路径>', '一份清单建一批：数组每项 {id,title,plainTitle,model,scope,deps,wave,desc}'],
    ],
    examples: [
      'add FEAT-12 --project myproj --model "opus·中" --title "登录失败连续 5 次锁定账号 30 分钟…" --plain-title "连续输错密码要能自动锁一会儿，防有人硬猜"',
      'add --project myproj --json-file cards.json',
    ],
    notes: [
      '--model 与 --plain-title 是机器闸：少一个当场拒收，报错里给照抄模板。',
      '批量是全有或全无：任一项不合格整批拒收并把全部错误一次列出。',
    ],
  },
  unclaim: {
    summary: '放弃认领（施工中 → 待开工/可复工，进度不清零）',
    usage: 'unclaim <卡号> --project <id> --reason <理由> [--branch <分支>...]',
    args: [
      ['--reason <文本>', '为什么不做了 / 转手给谁'],
      ['--branch <分支>', '从卡上摘掉哪些分支，可重复；不给就摘当前 git 分支'],
    ],
    examples: ['unclaim FEAT-12 --project myproj --reason "对话中断，交回给下一个人"'],
    notes: [
      '只能从「施工中」退回；解除过暂缓的卡退回「可复工」，其余退回「待开工」。',
      '进度保留——「做到 60% 没人接」比「回到 0」更接近事实。',
    ],
  },
  cancel: {
    summary: '作废：这活不做了（任意状态 → 已作废）',
    usage: 'cancel <卡号> --project <id> --reason <理由>',
    args: [['--reason <文本>', '为什么不做了：方案被否 / 需求撤了 / 重复建卡']],
    examples: ['cancel FEAT-12 --project myproj --reason "需求撤了，改走新方案"'],
    notes: [
      '别拿 done 当垃圾桶——完工数里混进没干的活，进度就不可信了。',
      '作废卡不进完成度的分母（它不是「没做完」，是「不做了」）。',
    ],
  },
  reopen: {
    summary: '重开：结了案又要重来（已完工/已作废 → 待开工）',
    usage: 'reopen <卡号> --project <id> --reason <理由>',
    args: [['--reason <文本>', '为什么要重来：验收没过 / 当初作废的活又要做了']],
    examples: ['reopen FEAT-12 --project myproj --reason "验收发现锁定时长算错了，返工"'],
    notes: [
      'percent 归 0、完工日期清空；PR / 提交 / 拍板记录全留——重开不是重建。',
      '活动流一条不删，返工历史查得到。',
    ],
  },
  edit: {
    summary: '改卡面文字（标题/人话标题/说明/档位/波次），带校验',
    usage: 'edit <卡号> --project <id> [--title <技术说明>] [--plain-title <人话标题>] [--desc <一句话>] [--model <档位>] [--wave <n>]',
    args: [
      ['--title <文本>', '给模型看的技术说明，不能改成空'],
      ['--plain-title <文本>', '给负责人看的一句人话，不能改成空'],
      ['--desc <文本>', '一句话补充说明，允许改成空串'],
      ['--model <档位>', '建议施工档位，≤40 字符'],
      ['--wave <n>', '波次，≥0 的整数'],
    ],
    examples: ['edit FEAT-12 --project myproj --plain-title "连续输错密码要能自动锁一会儿"'],
    notes: [
      '至少给一个要改的字段；flag 后面漏写值当场拒（那是手误，不是"要清空"）。',
      '只认这五个字段——写错字段名就往卡上挂一个谁也不认识的属性，那是 `set` 的老毛病。',
    ],
  },
  park: {
    summary: '主动挂起一张卡（转「暂缓」并写清为什么）',
    usage: 'park <卡号> --project <id> --reason <理由> [--note <遗留>]',
    args: [
      ['--reason <文本>', '为什么挂起'],
      ['--note <文本>', '遗留了什么，下一个人从哪接'],
    ],
    examples: ['park FEAT-12 --project myproj --reason "等上游接口定稿" --note "已完成表单校验，差提交按钮接线"'],
    notes: ['再次 park 会抹掉上一轮的解除依据，免得两套说法并存。'],
  },
  unpark: {
    summary: '解除暂缓（转「可复工」，解除依据单独留痕）',
    usage: 'unpark <卡号> --project <id> --reason <解除依据>',
    args: [['--reason <文本>', '凭什么可以复工了']],
    examples: ['unpark FEAT-12 --project myproj --reason "上游接口已合入 main"'],
    notes: ['只能从「暂缓」解除；旧的阻塞理由与遗留说明会被清掉。'],
  },
  block: {
    summary: '登记这张卡被哪些卡挡住了',
    usage: 'block <卡号> --project <id> --by <卡号>... [--reason <理由>]',
    args: [
      ['--by <卡号>', '挡住它的卡，可重复'],
      ['--reason <文本>', '卡在哪'],
    ],
    examples: ['block FEAT-12 --project myproj --by FEAT-09 --reason "要等新的鉴权中间件"'],
    notes: [],
  },
  set: {
    summary: '兜底：直接给某个字段赋值（有专门命令的字段优先用专门命令）',
    usage: 'set <卡号> --project <id> --field <点路径> --value <json或纯文本>',
    args: [
      ['--field <点路径>', '如 plainTitle、deps.dependsOn、dates.done'],
      ['--value <值>', '能解析成 JSON 就按 JSON 存，否则按字符串存'],
    ],
    examples: ['set FEAT-12 --project myproj --field plainTitle --value "连续输错密码要能自动锁一会儿"'],
    notes: ['写完必须回读复核：并行写会互相覆盖。'],
  },
  'mark-landed': {
    summary: '把某条已拍板的决策标记为"代码已落地"',
    usage: 'mark-landed <卡号> --project <id> (--did <dN> | --all) [--commit <sha>]',
    args: [
      ['--did <dN>', '哪条决策'],
      ['--all', '本卡所有「已拍板但没标落地」的决策一次标完'],
      ['--commit <sha>', '落地在哪个提交'],
    ],
    examples: ['mark-landed FEAT-12 --project myproj --did d1 --commit a1b2c3d',
      'mark-landed FEAT-12 --project myproj --all'],
    notes: ['还没拍板的决策不能标落地。', '`done` 收官时会自动把本卡未标落地的已拍板决策一起结掉。'],
  },
  'sync-progress': {
    summary: '按当前分支自动同步进度（TodoWrite 钩子调用，一般不手动跑）',
    usage: 'sync-progress [--project <id>] --percent <n> [--branch <分支>]',
    args: [
      ['--percent <n>', '待办清单的完成比'],
      ['--branch <分支>', '不传就读当前 git 分支'],
      ['--project <id>', '不传就按当前 git 仓反查是哪个项目'],
    ],
    examples: ['sync-progress --percent 60'],
    notes: ['只进不退、自动进度封顶 95；找不到匹配的施工中卡就静默跳过。'],
  },

  // ——— 装机与维护 ———
  register: {
    summary: '把一个项目登记进注册表并建一块空板',
    usage: 'register --id <id> --name <名字> --root <主仓路径> [--board <board.json 路径>]',
    args: [
      ['--id <id>', '项目 id，之后所有命令的 --project 都用它'],
      ['--name <名字>', '显示名'],
      ['--root <路径>', '主仓路径'],
      ['--board <路径>', '板文件落点，默认 <主仓>/.dashboard/board.json'],
    ],
    examples: ['register --id myproj --name "我的项目" --root <项目路径>'],
    notes: ['要连 hook 和协议文本一起装，用 enroll。'],
  },
  enroll: {
    summary: '一键接入新项目：注册 + 装钩子 + 写协议文本（可顺带导入台账）',
    usage: 'enroll --id <id> --name <名字> --root <项目路径> [--no-hooks] [--from <台账.md>]',
    args: [
      ['--id / --name / --root', '同 register'],
      ['--no-hooks', '只注册，不装 git 钩子'],
      ['--from <文件>', '顺带从这份任务台账导入卡'],
    ],
    examples: ['enroll --id myproj --name "我的项目" --root <项目路径>'],
    notes: [],
  },
  'hooks-install': {
    summary: '给某个项目装 git 钩子与协议文本',
    usage: 'hooks-install --project <id> [--repo <仓库路径>]',
    args: [['--repo <路径>', '装到哪个仓，默认项目登记的代码仓']],
    examples: ['hooks-install --project myproj'],
    notes: ['钩子里写的是发布副本的路径，不会指进任何 git 检出。'],
  },
  'hooks-global': {
    summary: '装全局自动进度钩子（对所有对话生效，含 worktree）',
    usage: 'hooks-global',
    args: [['（无）', '不吃参数']],
    examples: ['hooks-global'],
    notes: ['装完后更新待办清单会自动回写进度。'],
  },
  'hooks-trunk-guard': {
    summary: '装"主工位别停在功能分支"的提醒钩子（只提醒不拦）',
    usage: 'hooks-trunk-guard [--repo <检出路径>] [--trunk <主干名>]',
    args: [
      ['--repo <路径>', '装到哪个检出，默认当前代码根'],
      ['--trunk <名字>', '主干分支名，默认自动探测'],
    ],
    examples: ['hooks-trunk-guard'],
    notes: ['只在主工位切分支时吵一声；worktree 里切分支不管。'],
  },
  release: {
    summary: '从主干导出一份发布副本（钩子和网页服务跑的都是它）',
    usage: 'release [--source <检出>] [--dest <目录>] [--commit <sha>] [--no-fetch] [--skip-web] [--print-dest] [--no-bootstrap] [--force]',
    args: [
      ['--source <路径>', '从哪个检出导出'],
      ['--dest <路径>', '副本落点，默认发布副本目录'],
      ['--commit <sha>', '导出指定提交，默认主干最新'],
      ['--no-fetch', '不先 fetch'],
      ['--skip-web', '只发后台，不构建界面（这份副本起不出网页）'],
      ['--print-dest', '只打印副本目录就退出'],
      ['--no-bootstrap', '改了发布工具本身时不自动改用新版重跑（应急用；那一次新逻辑不生效）'],
      ['--force', '副本已经是这一版也照发一遍（默认会跳过，省掉几秒重建）'],
    ],
    examples: ['release', 'release --skip-web'],
    notes: [
      '看板自己的代码合进主干后要跑一次，否则钩子和网页还是旧的。',
      '改的要是发布工具自己：会自动把新版导出来、由新版铺副本（否则得连跑两次才真生效）。',
      '副本已经是这一版就直接跳过（启动器每次双击都跑它，白重建一次界面要五六秒）。',
    ],
  },
  'claim-check': {
    summary: '检查当前分支有没有认领（pre-commit 闸门调它）',
    usage: 'claim-check [--branch <分支>] [--repo <仓库>]',
    args: [
      ['--branch <分支>', '不传就读当前分支'],
      ['--repo <路径>', '不传就用当前仓'],
    ],
    examples: ['claim-check'],
    notes: ['临时放行用环境变量 DASHBOARD_SKIP_CLAIM_CHECK=1。'],
  },
  doctor: {
    summary: '体检：钩子装没装、提交有没有漏记、分支台账脏不脏',
    usage: 'doctor --project <id> [--quick] [--quiet] [--fix] [--branches] [--n <扫描条数>]',
    args: [
      ['--quick', '只查钩子安装和待拍板三件套；跳过发布副本、提交扫描、分支审计与修复'],
      ['--quiet', '无问题时不输出，有问题时只列问题'],
      ['--fix', '能自动修的就修（漏记的提交、脏分支台账）'],
      ['--branches', '连分支台账一起体检'],
      ['--n <条数>', '往回扫多少条提交，默认 300'],
    ],
    examples: ['doctor --project myproj', 'doctor --project myproj --branches --fix', 'doctor --project myproj --quick --quiet'],
    notes: [],
  },
  'sync-from-git': {
    summary: '扫 git 历史，把提交号/分支/PR 补进对应的卡',
    usage: 'sync-from-git --project <id> [--branch <分支>] [--commit <sha>] [--n <扫描条数>]',
    args: [
      ['--branch <分支>', '把这个分支名记到匹配到的卡上'],
      ['--commit <sha>', '只处理这一个提交'],
      ['--n <条数>', '往回扫多少条，默认 300'],
    ],
    examples: ['sync-from-git --project myproj'],
    notes: ['装了 post-commit 钩子后每次提交自动跑，一般不手动调。'],
  },
  cleanup: {
    summary: '收工清理：摘掉工位与已合并的分支',
    usage: 'cleanup --repo <主仓> --worktree <工位路径> [--branch <分支>] [--yes]',
    args: [
      ['--repo <路径>', '主仓'],
      ['--worktree <路径>', '要摘的工位'],
      ['--branch <分支>', '顺带删掉这个分支'],
      ['--yes', '不再问，直接执行'],
    ],
    examples: ['cleanup --repo <主仓路径> --worktree <工位路径> --branch feat/login --yes'],
    notes: ['工位里的 node_modules 若是软链，只摘链接、不跟着删真实目录。'],
  },
  'docs-audit': {
    summary: '文档巡检：哪些设计稿该转历史、哪些该复核、哪些没写状态',
    usage: 'docs-audit --project <id> [--create-card] [--monthly-tick] [--stale-days <n>] [--recheck-days <n>]',
    args: [
      ['--create-card', '有问题就自动建一张巡检卡'],
      ['--monthly-tick', '按月节拍跑，未到期就跳过'],
      ['--stale-days <n>', '完工多少天后算"该转历史"，默认 30'],
      ['--recheck-days <n>', '多少天没动算"该复核"，默认 90'],
    ],
    examples: ['docs-audit --project myproj'],
    notes: [],
  },

  // ——— 导入导出 ———
  'archive-activity': {
    summary: '把指定月份以前的旧活动按月归档，网页仍能查看完整历史',
    usage: 'archive-activity --project <id> --before <YYYY-MM>',
    args: [['--before <YYYY-MM>', '必填；该月 1 日本地时间 00:00 以前的活动搬入月度归档']],
    examples: ['archive-activity --project myproj --before 2026-09'],
    notes: [
      '归档存于 board.json 旁的 activity-YYYYMM.json，已有文件合并去重；不自动执行。',
      '输出搬入条数与文件路径；没有旧活动时不改文件，重复执行安全。',
    ],
  },
  import: {
    summary: '从任务台账（INDEX.md / BOARD.md）半自动生成板的骨架',
    usage: 'import --project <id> [--from <台账.md>] [--dry-run]',
    args: [
      ['--from <文件>', '台账路径，默认项目文档根下的 INDEX.md / BOARD.md'],
      ['--dry-run', '只看解析结果不落盘'],
    ],
    examples: ['import --project myproj --dry-run'],
    notes: ['只抽可靠字段；决策/测试/禁区这些语义字段要另外补。'],
  },
  backfill: {
    summary: '批量补语义字段，或列出还缺哪些',
    usage: 'backfill --project <id> [--patch <补丁.json>]',
    args: [['--patch <文件>', '补丁格式 {卡号:{"点路径":值,…}}，走锁 + 校验落盘']],
    examples: ['backfill --project myproj', 'backfill --project myproj --patch patch.json'],
    notes: ['不带 --patch 就是只读清点，告诉你哪些卡缺什么。'],
  },
  onboard: {
    summary: '首次接入一条龙：import 骨架 → backfill 补丁 → sync-from-git 补 git 字段',
    usage: 'onboard --project <id> [--from <台账.md>] [--patch <补丁.json>] [--no-git]',
    args: [
      ['--from <文件>', '台账路径'],
      ['--patch <文件>', '语义补丁'],
      ['--no-git', '跳过扫 git 历史那一步'],
    ],
    examples: ['onboard --project myproj'],
    notes: ['重复跑会以 import 重建骨架，人工补过语义的板慎用。'],
  },
  'render-index': {
    summary: '从板生成台账里的状态段（只替换锚之间的内容，不碰人工叙事）',
    usage: 'render-index --project <id> [--index <台账.md>] [--dry-run]',
    args: [
      ['--index <文件>', '目标台账，默认项目登记的那份'],
      ['--dry-run', '只看要写什么，不落盘'],
    ],
    examples: ['render-index --project myproj --dry-run'],
    notes: ['台账里没有那对注释锚就报错不写，绝不猜位置覆盖人工内容。'],
  },
  snapshot: {
    summary: '把板导出成一份带时间戳的快照文件',
    usage: 'snapshot --project <id> [--out <目录>] [--stamp <时间戳>]',
    args: [
      ['--out <目录>', '落点，默认数据根下的 snapshots/<项目id>'],
      ['--stamp <文本>', '文件名用的时间戳，默认当前时刻'],
    ],
    examples: ['snapshot --project myproj'],
    notes: ['板不进 git，历史留痕靠这个。'],
  },
};

const { displayWidth, padRight: pad } = require('../core/termText.cjs');

/** 一条命令的一屏帮助:用法 / 参数 / 示例 / 退出码 / 补充。 */
function renderCommandHelp(cmd, { cli = 'cli' } = {}) {
  const e = COMMANDS[cmd];
  if (!e) return null;
  const out = [`${cmd} —— ${e.summary}`, '', '【用法】'];
  for (const line of e.usage.split('\n')) out.push('  ' + line);
  out.push('', '【参数】');
  const rows = [...e.args, ...GLOBAL_FLAGS.filter(([f]) => !e.args.some(([a]) => a.startsWith(f.split(' ')[0])))];
  const w = Math.max(...rows.map(([f]) => displayWidth(f)));
  for (const [f, d] of rows) out.push(`  ${pad(f, w)}  ${d}`);
  out.push('', '【示例】');
  for (const ex of e.examples) out.push(`  ${cli} ${ex}`);
  if (e.notes && e.notes.length) {
    out.push('', '【要点】');
    for (const n of e.notes) out.push('  · ' + n);
  }
  out.push('', '【退出码】 ' + EXIT_CODES.map(([c, d]) => `${c}=${d}`).join('；'));
  return out.join('\n');
}

/** 全局帮助:分组列出全部命令 + 一句话。 */
function renderGlobalHelp({ cli = 'cli', commands = Object.keys(COMMANDS) } = {}) {
  const known = new Set(commands);
  const out = [
    `用法: ${cli} <命令> [<卡号>] --project <项目id> [参数]`,
    `单条命令的详细用法：${cli} <命令> --help`,
    '',
    '【命令一览】',
  ];
  const listed = new Set();
  for (const [group, cmds] of GROUPS) {
    const rows = cmds.filter((c) => known.has(c));
    if (!rows.length) continue;
    out.push('', `· ${group}`);
    const w = Math.max(...rows.map((c) => displayWidth(c)));
    for (const c of rows) { listed.add(c); out.push(`    ${pad(c, w)}  ${(COMMANDS[c] || {}).summary || ''}`); }
  }
  const rest = commands.filter((c) => !listed.has(c));
  if (rest.length) {
    out.push('', '· 其它');
    const w = Math.max(...rest.map((c) => displayWidth(c)));
    for (const c of rest) out.push(`    ${pad(c, w)}  ${(COMMANDS[c] || {}).summary || ''}`);
  }
  out.push('', '【全局 flag】');
  const w = Math.max(...GLOBAL_FLAGS.map(([f]) => displayWidth(f)));
  for (const [f, d] of GLOBAL_FLAGS) out.push(`    ${pad(f, w)}  ${d}`);
  out.push('', '【退出码】 ' + EXIT_CODES.map(([c, d]) => `${c}=${d}`).join('；'));
  out.push('', `新对话开工先跑：${cli} protocol，再 brief <卡号> --project <项目id>`);
  return out.join('\n');
}

module.exports = { COMMANDS, GLOBAL_FLAGS, EXIT_CODES, GROUPS, renderCommandHelp, renderGlobalHelp };
