'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
function* files(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* files(file);
    else if (entry.isFile()) yield file;
  }
}

test('动画目录、组件和两个旧测试均已删除', () => {
  for (const file of ['web/src/workfloor', 'web/src/components/WorkFloor.vue',
    'web/src/components/AppearanceWorkfloor.vue', 'test/workfloorBridge.test.cjs',
    'test/workfloorDayNight.test.cjs']) {
    assert.equal(fs.existsSync(path.join(root, file)), false, file);
  }
});

test('源码和测试文本不再引用施工现场（仅排除此回归文件）', () => {
  for (const dir of ['web/src', 'web/tests', 'test']) {
    for (const file of files(path.join(root, dir))) {
      if (file === __filename) continue;
      const data = fs.readFileSync(file);
      if (data.includes(0)) continue; // 二进制文件不参与文本扫描。
      assert.doesNotMatch(data.toString('utf8'), /workfloor|施工现场/i, path.relative(root, file));
    }
  }
});

test('前端不再保留动画专属样式变量与位置类', () => {
  for (const file of files(path.join(root, 'web/src'))) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /--wf-|wf-bottom/i, path.relative(root, file));
  }
});

test('提示音仅保留三种音色和试听入口，施工音效已删除', () => {
  const source = read('web/src/utils/sound.ts');
  assert.doesNotMatch(source, /\b(?:weld|stamp|alarm|done|ignition|liftoff|complete|hold)\b/);
  assert.match(source, /type Cue = 'ding' \| 'dong' \| 'low'/);
  for (const line of ["case 'ding': ding(at); break", "case 'dong': dong(0.65); break",
    "case 'low': low(at, 0.52); break",
    'export async function playSound(cue: Cue, opts?: { preview?: boolean }): Promise<void>']) {
    assert.ok(source.includes(line), line);
  }
  assert.match(source, /if \(!preview && \(muted\(\) \|\| shouldThrottle/);
});

test('看板保留泳道内滚，外观中心默认首项且保留声音页', () => {
  const kanban = read('web/src/views/Kanban.vue');
  assert.match(kanban, /\.page \{[^}]*height: 100%/);
  assert.match(kanban, /\.column-body \{[^}]*overflow-y: auto/s);
  const center = read('web/src/components/AppearanceCenter.vue');
  assert.match(center, /const active = ref<.*>\('color'\)/);
  assert.match(center, /\{ id: 'color', label: '主题与配色' \}/);
  assert.match(center, /<AppearanceSound v-else-if="active === 'sound'"/);
});

test('旧外观存档的 workfloor 被忽略，其余设置读出且写回不带旧字段（tsx 实际解析）', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const saved = {
      version: 1, speed: 0.62, glow: 1.5, breathe: true, density: 0.75, fontSize: 16,
      confetti: false, confettiCount: 90, streakFire: false, streakGrace: false,
      projectColor: false, projectMark: 'letter', projectRing: 'project',
      projectColors: { demo: 'pink' }, projectIcons: { demo: 'calendar' },
      sound: true, volume: 65, quietStart: '23:15', quietEnd: '07:45',
      notify: true, notifyEvents: { pending: false, done: true, block: false },
      ageThresholds: [10, 20, 30], wipLimits: { 施工中: 9 },
      wireEvents: { done: false, pending: true, block: false },
    };
    let stored = JSON.stringify({ ...saved, workfloor: { world: 'mech', soundLink: true } });
    globalThis.localStorage = {
      getItem: () => stored,
      setItem: (key, value) => { assert.equal(key, 'board-appearance-config'); stored = value; },
    };
    const { defaultAppearance, normalizeAppearance, appearance, applyAppearance } =
      await import('./web/src/utils/appearance.ts');
    const plain = value => JSON.parse(JSON.stringify(value));
    assert.equal(Object.hasOwn(defaultAppearance(), 'workfloor'), false);
    assert.deepEqual(plain(appearance), saved);
    for (const obsolete of [{ world: 'launch' }, null, 'invalid', 42]) {
      let parsed;
      assert.doesNotThrow(() => { parsed = normalizeAppearance({ ...saved, workfloor: obsolete }); });
      assert.deepEqual(plain(parsed), saved);
    }
    globalThis.document = { documentElement: {
      style: { setProperty() {}, removeProperty() {} }, setAttribute() {}, removeAttribute() {},
    } };
    applyAppearance();
    assert.deepEqual(JSON.parse(stored), saved);
  `], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr + result.stdout);
});
