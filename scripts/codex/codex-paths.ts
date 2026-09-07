/**
 * Codex 派单的落盘约定(CODEX-BRIDGE-DISPATCH,2026-09-01)。
 *
 * 【定位】只回答一个问题:某个工单的各类产物落在哪。抽成单文件是因为派单侧、执行侧、
 * 判读侧都要拼同一批路径,散在三处迟早漂移——漂移的表现是"派单器说没有结论文件,
 * 而结论明明躺在隔壁目录",这类故障排查成本极高。
 *
 * 【为什么全在 .codex/jobs/ 下、且不进 git】工单目录装的是运行副产品:
 * 几十兆的 JSONL 事件流、进程状态、Codex 的原始输出。它们是**证据**不是**源码**,
 * 留在本机可复查即可;进了版本库只会把仓库撑爆,还会和并行会话的提交互相污染
 * (§8.C "自动化副产品提交前还原"同源)。
 */
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根:本文件位于 <repo>/scripts/codex/,上跳两级。 */
export const REPO_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..', '..'))

/** 所有工单的根目录。整棵树都不进 git(见 .gitignore)。 */
export const JOBS_ROOT = join(REPO_ROOT, '.codex', 'jobs')

/** Codex 派出去的独立工作区放这里,沿用 2026-07 就有的老约定。 */
export const CODEX_WORKTREES_ROOT = join(REPO_ROOT, '.codex', 'worktrees')

export interface JobPaths {
  /** 工单根目录 */
  dir: string
  /** 派单单(冻结后不许再改;判读时复核哈希) */
  task: string
  /** 冻结哈希 + 派单时刻的 git 基线 */
  meta: string
  /** 渲染后的完整 prompt(留档,便于复现"当时到底跟它说了什么") */
  prompt: string
  /** codex exec --json 的原始事件流 */
  execLog: string
  /** codex exec -o 写出的最后一条消息(应为符合 schema 的 JSON) */
  lastMessage: string
  /** 派单器机器复核后的最终判决 */
  verdict: string
  /** 进程状态(pid / 起止时刻 / 退出码) */
  state: string
  /** 续聊的逐轮问答记录(out=派单方,in=Codex) */
  chatLog: string
  /** 各条验收项自己重跑的原始输出 */
  acceptanceLogDir: string
}

export const jobPaths = (slug: string): JobPaths => {
  const dir = join(JOBS_ROOT, slug)
  return {
    dir,
    task: join(dir, 'task.json'),
    meta: join(dir, 'meta.json'),
    prompt: join(dir, 'prompt.txt'),
    execLog: join(dir, 'exec.jsonl'),
    lastMessage: join(dir, 'last-message.json'),
    verdict: join(dir, 'verdict.json'),
    state: join(dir, 'state.json'),
    chatLog: join(dir, 'chat.jsonl'),
    acceptanceLogDir: join(dir, 'acceptance'),
  }
}

/** Codex 独立工作区的路径与分支名(--worktree 时用)。 */
export const worktreeFor = (slug: string): { path: string; branch: string } => ({
  path: join(CODEX_WORKTREES_ROOT, slug),
  branch: 'codex/' + slug,
})
