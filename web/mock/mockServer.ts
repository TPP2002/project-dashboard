// dev-only mock：实现完整 API 契约（含 SSE + POST decide 写内存 + 广播），供 server 未就绪时联调。
// 仅在 mode=mock 挂载；configureServer 只在 dev 生效，绝不进 build 产物。
import type { Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.join(here, 'data')

interface MockBoard {
  schemaVersion: string
  project: { id: string; name: string; mainRepo?: string; createdAt?: string; updatedAt?: string; forbiddenZones?: string[] }
  tasks: Array<Record<string, unknown>>
  activity?: Array<Record<string, unknown>>
}

function sendJson(res: ServerResponse, code: number, body: unknown) {
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}
function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

export function mockApiPlugin(): Plugin {
  const boards: Record<string, MockBoard> = {}
  for (const f of fs.readdirSync(dataDir).filter((n) => n.endsWith('.json'))) {
    const b = JSON.parse(fs.readFileSync(path.join(dataDir, f), 'utf8')) as MockBoard
    boards[b.project.id] = b
  }
  const subscribers = new Set<ServerResponse>()
  function broadcast(projectId: string) {
    const payload = `event: board:changed\ndata: ${JSON.stringify({ projectId })}\n\n`
    for (const res of subscribers) {
      try {
        res.write(payload)
      } catch {
        /* 断开的连接由 close 事件清理 */
      }
    }
  }

  return {
    name: 'mock-dashboard-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url || ''
        if (!url.startsWith('/api/')) return next()
        const u = new URL(url, 'http://localhost')
        const p = u.pathname
        const method = req.method || 'GET'

        // SSE
        if (p === '/api/stream') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          })
          res.write(': connected\n\n')
          subscribers.add(res)
          const hb = setInterval(() => {
            try {
              res.write(': ping\n\n')
            } catch {
              /* ignore */
            }
          }, 15000)
          req.on('close', () => {
            clearInterval(hb)
            subscribers.delete(res)
          })
          return
        }

        // GET /api/projects
        if (p === '/api/projects' && method === 'GET') {
          const list = Object.values(boards).map((b) => ({
            id: b.project.id,
            name: b.project.name,
            mainRepo: b.project.mainRepo,
            updatedAt: b.project.updatedAt,
          }))
          return sendJson(res, 200, list)
        }

        // GET /api/board/:id
        const mBoard = p.match(/^\/api\/board\/([^/]+)$/)
        if (mBoard && method === 'GET') {
          const b = boards[decodeURIComponent(mBoard[1])]
          if (!b) return sendJson(res, 404, { error: '项目不存在' })
          return sendJson(res, 200, b)
        }

        // GET /api/doc?projectId=&path=
        if (p === '/api/doc' && method === 'GET') {
          const pid = u.searchParams.get('projectId') || ''
          const docp = u.searchParams.get('path') || ''
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
          return res.end(
            `# ${docp}\n\n（mock 文档占位）\n项目：${pid}\n\n真实 server 会经 safePath.resolveInsideRoot（realpath + path.relative）校验后返回文件内容；` +
              `此处仅为前端联调占位。\n`,
          )
        }

        // POST /api/decide/:pid/:taskId  { did, answer, author }
        const mDec = p.match(/^\/api\/decide\/([^/]+)\/([^/]+)$/)
        if (mDec && method === 'POST') {
          readBody(req)
            .then((body) => {
              const pid = decodeURIComponent(mDec[1])
              const tid = decodeURIComponent(mDec[2])
              const b = boards[pid]
              if (!b) return sendJson(res, 404, { error: '项目不存在' })
              const t = b.tasks.find((x) => x.id === tid) as Record<string, unknown> | undefined
              if (!t) return sendJson(res, 404, { error: '任务不存在' })
              const decisions = (t.decisions as Array<Record<string, unknown>>) || []
              const d = decisions.find((x) => x.id === body.did)
              if (!d) return sendJson(res, 404, { error: `decision ${body.did} 不存在` })
              const opts = (d.options as string[]) || []
              if (!opts.includes(body.answer as string)) {
                return sendJson(res, 400, { error: `答案「${body.answer}」不在选项中` })
              }
              d.answer = body.answer
              d.decidedAt = new Date().toISOString().slice(0, 10)
              if (decisions.every((x) => x.answer != null) && t.status === '待拍板') t.status = '已拍板'
              b.activity = b.activity || []
              b.activity.push({
                ts: new Date().toISOString(),
                author: (body.author as string) || '看板',
                type: 'decide',
                text: `拍板 ${tid}·${body.did}=${body.answer}`,
                taskId: tid,
              })
              b.project.updatedAt = new Date().toISOString()
              broadcast(pid)
              return sendJson(res, 200, { ok: true, task: t })
            })
            .catch((e) => sendJson(res, 500, { error: String(e) }))
          return
        }

        return sendJson(res, 404, { error: '未知 API：' + p })
      })
    },
  }
}
