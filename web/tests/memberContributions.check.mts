import { test } from 'node:test'
import assert from 'node:assert/strict'
import { contributionsPath, actionLabel, doneSplit, memberColor } from '../src/collaboration/contrib.ts'
import type { ContributionAction, ContributionWeeks } from '../src/collaboration/contrib.ts'

test('contributionsPath encodes project IDs as a single segment and preserves each supported range', () => {
  for (const weeks of [4, 8, 12] as ContributionWeeks[]) {
    assert.equal(contributionsPath('alpha', weeks), `/api/collaboration/projects/alpha/contributions?weeks=${weeks}`)
  }
  assert.equal(contributionsPath('项目 /?#&', 8), '/api/collaboration/projects/%E9%A1%B9%E7%9B%AE%20%2F%3F%23%26/contributions?weeks=8')
})

test('actionLabel covers every server action with the contracted Chinese verb', () => {
  const expected: Record<ContributionAction, string> = {
    create: '建卡', message: '留言于', claim: '领取', progress: '更新进度', join: '加入协作', leave: '退出协作',
    removeCollaborator: '移出协作人', unclaim: '放弃认领', park: '暂缓', unpark: '复工', done: '收官', cancel: '作废', reopen: '重开', other: '操作了',
  }
  for (const [action, label] of Object.entries(expected)) assert.equal(actionLabel(action as ContributionAction), label)
})

test('doneSplit scales both contributions against the same maximum without hiding collaboration', () => {
  const member = Object.freeze({ completedAsOwner: 9, completedAsCollaborator: 3 })
  assert.deepEqual(doneSplit(member, 15), { owner: 60, collaborator: 20 })
  assert.deepEqual(doneSplit(member, 12), { owner: 75, collaborator: 25 })
  assert.deepEqual(doneSplit(member, 0), { owner: 0, collaborator: 0 })
  assert.deepEqual(doneSplit({ completedAsOwner: 0, completedAsCollaborator: 0 }, 15), { owner: 0, collaborator: 0 })
  assert.deepEqual(doneSplit({ completedAsOwner: 0, completedAsCollaborator: 4 }, 8), { owner: 0, collaborator: 50 })
})

test('memberColor uses five theme tokens in order, repeats at six and reserves gray for unsigned', () => {
  assert.deepEqual(Array.from({ length: 5 }, (_, i) => memberColor(i)), ['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5'])
  for (let i = 0; i < 15; i++) assert.equal(memberColor(i + 5), memberColor(i))
  assert.equal(memberColor(-1), '--chart-7')
})
