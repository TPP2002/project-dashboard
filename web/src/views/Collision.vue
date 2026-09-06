<script setup lang="ts">
// 占用防撞：当前项目内，同一 分支 / worktree / 文件域 被多张卡占用即冲突高亮。
//
// 默认只数【还没结案】的卡（判据 = core/taskSignal.cjs 的 isOccupying）。完工卡的分支是历史遗迹，
// 不是抢占：0907 审计实测这页报 36 处冲突，绝大多数是完工卡的旧分支互相"撞"，真冲突全被淹掉。
// 暂缓卡照旧算占——它的 worktree 还实实在在检出着，别人抢同一个照样撞。
// 想看历史就点「含已完工」，那是查账用的口径，不是默认口径。
import Icon from '@/components/Icon.vue'
import type { IconName } from '@/icons/paths'
import { computed, ref } from 'vue'
import { useBoardStore } from '@/stores/board'
import { isGeneratedArtifact } from 'virtual:generated-artifacts'
import { isSettled, occupancy, type OccupancyRow } from 'virtual:task-signal'
import type { Task } from '@/types'

const store = useBoardStore()
const pid = computed(() => store.currentProjectId || '')
const tasks = computed<Task[]>(() => store.currentBoard?.tasks ?? [])
const includeDone = ref(false)

// 有历史占用的完工卡有几张——开关上要写清"被挡掉的是什么"，不能让人以为数据丢了。
const doneHolders = computed(
  () =>
    tasks.value.filter(
      (t) => isSettled(t) && ((t.gitBranch?.length ?? 0) + (t.worktree?.length ?? 0) + (t.fileScope?.length ?? 0)) > 0,
    ).length,
)

// 自动生成物（docs/INDEX-自动生成.md、lock 文件、dist/ 等）谁干活都会碰：多张卡同时挂着它是常态，
// 不是抢同一个文件，标红只会把真冲突淹掉（卡 BOARD-FILESCOPE-INDEX-POLLUTION）。判据与
// CLI / 并行清单同源（core/generatedArtifacts.cjs）。
function occ(field: 'gitBranch' | 'worktree' | 'fileScope'): OccupancyRow[] {
  return occupancy(tasks.value, field, { includeDone: includeDone.value, isGenerated: isGeneratedArtifact })
}
const branches = computed(() => occ('gitBranch'))
const worktrees = computed(() => occ('worktree'))
const scopes = computed(() => occ('fileScope'))
const conflictCount = computed(
  () => [...branches.value, ...worktrees.value, ...scopes.value].filter((x) => x.conflict).length,
)

// 每段配一枚功能图标：小标题只有几个字，纯文字排一列会糊成一片。
const SECTIONS = computed((): { title: string; icon: IconName; rows: OccupancyRow[] }[] => [
  { title: '分支占用', icon: 'branch', rows: branches.value },
  { title: 'worktree 占用', icon: 'tree', rows: worktrees.value },
  { title: '文件域占用', icon: 'folder', rows: scopes.value },
])
function open(id: string) { store.openTask(id, pid.value) }
</script>

<template>
  <div>
    <div class="head">
      <h2><Icon name="merge" class="head-ic" :size="20" />占用防撞</h2>
      <span class="badge" :class="conflictCount ? 'bad' : 'ok'">{{ conflictCount ? conflictCount + ' 处冲突' : '无冲突' }}</span>
      <span class="spacer" />
      <label v-if="doneHolders" class="inc-done" :class="{ on: includeDone }">
        <input type="checkbox" v-model="includeDone" />
        <span v-if="!includeDone"><Icon name="archive" :size="14" />含已完工（{{ doneHolders }} 张完工卡的历史占用未计）</span>
        <span v-else><Icon name="check" :size="14" />含已完工的历史占用（{{ doneHolders }} 张）· 点此只看在用的</span>
      </label>
    </div>
    <p class="hint">
      默认只数还没结案的卡：完工卡的分支是历史遗迹，不算抢占；暂缓卡照旧算占——它的 worktree 还检出着。
    </p>

    <div class="cols">
      <section v-for="s in SECTIONS" :key="s.title" class="sec card">
        <div class="sec-t"><Icon :name="s.icon" :size="14" />{{ s.title }}</div>
        <div v-if="!s.rows.length" class="muted small">无占用记录</div>
        <div v-for="r in s.rows" :key="r.v" class="orow row" :class="{ conflict: r.conflict }">
          <div class="ov mono">
            {{ r.v }}
            <span v-if="r.generated" class="badge n" title="自动生成物：谁干活都会碰，不算抢占；并行判断也会忽略它">共用生成物·不算冲突</span>
          </div>
          <div class="ots">
            <button
              v-for="t in r.tasks"
              :key="t.id"
              class="otag badge"
              :class="t.settled ? 'ok' : 'n'"
              type="button"
              @click="open(t.id)"
              :title="t.settled ? '已完工（历史占用）：' + t.title : t.title"
            >{{ t.id }}</button>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.head { display: flex; align-items: center; gap: var(--s3); margin-bottom: var(--s2); flex-wrap: wrap; }
.hint { margin: 0 0 var(--s4); color: var(--text-2); font-size: var(--fs-sm); }
.inc-done { display: inline-flex; align-items: center; gap: var(--s1); padding: var(--s1) var(--s2); border: 1px solid var(--line); border-radius: var(--r); color: var(--text-2); cursor: pointer; font-size: var(--fs-sm); user-select: none; }
.inc-done:hover { border-color: var(--line-strong); color: var(--text); }
.inc-done.on { border-color: var(--ok); background: var(--ok-bg); color: var(--ok); }
.inc-done input { margin: 0; cursor: pointer; }
.inc-done span { display: inline-flex; align-items: center; gap: var(--s1); }
.cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: var(--s4); align-items: start; }
.sec-t { display: flex; align-items: center; gap: var(--s2); margin-bottom: var(--s3); font-size: var(--fs-base); font-weight: 600; }
.orow {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: var(--s2);
  align-items: start;
}
.orow + .orow { margin-top: var(--s2); }
.orow.conflict { border-color: var(--bad); background: var(--bad-bg); }
.ov { min-width: 0; font-size: var(--fs-sm); overflow-wrap: anywhere; }
.ots { display: flex; gap: var(--s1); flex-wrap: wrap; }
.otag { cursor: pointer; }
.orow.conflict .otag { border-color: var(--bad); color: var(--bad); }
.small { font-size: var(--fs-sm); }
</style>
