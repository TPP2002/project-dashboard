export type Operation = 'dispatch.launch' | 'jobs.list' | 'jobs.get' | 'jobs.task' | 'jobs.dispatch' | 'jobs.say' | 'jobs.collect' | 'sessions.list' | 'sessions.get' | 'sessions.resume' | 'sessions.quota' | 'sessions.report' | 'usage.changes' | 'usage.details' | 'usage.balance' | 'project.doc.get' | 'project.facts' | 'ci.snapshot' | 'reader.sources.get' | 'reader.annotations.export' | 'audition.sources.get' | 'audition.annotations.export' | 'object.read' | 'object.write';
export interface ObjectRef { nodeId: string; projectId: string; kind: string; hash: string; size: number }
type Project = { projectId: string }
type Job = Project & { slug: string }
type Export = Project & { key: string; object: ObjectRef; contentVersion: string }
export interface Arguments {
  'dispatch.launch': Project & { mode: 'task'|'project'|'decision'; text: string; taskId?: string; decisionId?: string }
  'jobs.list': Project
  'jobs.get': Job & { tail?: boolean }
  'jobs.task': Job
  'jobs.dispatch': Job & { taskText?: string }
  'jobs.say': Job & { message: string }
  'jobs.collect': Job
  'sessions.list': Project & { limit?: number; days?: number }
  'sessions.get': Project & { sessionId: string; tail?: number }
  'sessions.resume': Project & { sessionId: string; message: string; sandboxMode?: 'read-only'|'workspace-write' }
  'sessions.quota': Project
  'sessions.report': Project & { days?: 1|7 }
  'usage.changes': { cursor: number; limit?: number; batch?: string; offset?: number }
  'usage.details': Project & { kind: 'sessions'|'jobs'; days?: number; fromDate?: string; toDate?: string; model?: string; card?: string; engine?: string }
  'usage.balance': Project
  'project.doc.get': Project & { relativePath: string }
  'project.facts': Project
  'ci.snapshot': Project
  'reader.sources.get': Project & ({ kind: 'manifest'; key?: string } | { kind: 'report'; key: string })
  'audition.sources.get': Project & ({ kind: 'index' } | { kind: 'batch'; key: string } | { kind: 'file'; relativePath: string })
  'reader.annotations.export': Export
  'audition.annotations.export': Export
  'object.read': { object: ObjectRef; offset: number; length: number }
  'object.write': { object: ObjectRef; offset: number; data: string }
}
type Write = 'dispatch.launch'|'jobs.dispatch'|'jobs.say'|'jobs.collect'|'sessions.resume'|'reader.annotations.export'|'audition.annotations.export'|'object.write'
export type Request = { [K in Operation]: { version: 'owner-node.v1'; direction: 'request'; generation: string; sequence: number; nonce: string; operation: K; args: Arguments[K] } & (K extends Write ? {operationId: string; hash: string} : {operationId?: never; hash?: never}) }[Operation]
export type Reply = { version: 'owner-node.v1'; direction: 'reply'; generation: string; sequence: number; nonce: string } & ({ ok: true; result: unknown } | { ok: false; error: { status: number; message: string } });
export interface ProjectConfig { codeRepo: string; docsRoot: string; name: string; githubRepo?: string; costRoots: string[] }
