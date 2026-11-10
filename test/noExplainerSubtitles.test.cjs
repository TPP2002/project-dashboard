'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const VIEWS = path.join(__dirname, '../web/src/views');
const read = (file) => fs.readFileSync(path.join(VIEWS, file), 'utf8');
const templateOf = (source) => source.slice(source.indexOf('<template>'), source.lastIndexOf('</template>'));
const styleOf = (source) => source.slice(source.lastIndexOf('<style'));

// 负责人 2026-11-11 定:标题下面不再配一句解释这块是什么、怎么看的话。
const HEADINGS = [
  ['Overview.vue', '<h1>总览</h1>'],
  ['Overview.vue', '<h2>需要你处理</h2>'],
  ['Overview.vue', '<h2>项目与统计</h2>'],
  ['DecisionHistory.vue', '拍板历史</h1>'],
  ['ApprovalCenter.vue', '待拍板</h1>'],
  ['Waves.vue', '波次视图</h1>'],
  ['ToLand.vue', '待落地</h1>'],
  ['Kanban.vue', '<h1>{{ board.project.name }}</h1>'],
  ['ParallelPlan.vue', '现在能同时派几张</h1>'],
  ['ParallelPlan.vue', '<h2>可以直接派 '],
  ['ParallelPlan.vue', '<h2>同一块地方,要排队 '],
  ['ParallelPlan.vue', '<h2>在等上游 '],
  ['ParallelPlan.vue', '<h2>已经有人在做 '],
];

for (const [file, marker] of HEADINGS) {
  test(`${file} 的标题 ${marker} 后面不跟说明段落`, () => {
    const lines = templateOf(read(file)).split(/\r?\n/);
    const hits = lines.map((line, index) => (line.includes(marker) ? index : -1)).filter((index) => index >= 0);
    assert.equal(hits.length, 1, '标题应当还在,且只出现一次');
    const next = lines.slice(hits[0] + 1).find((line) => line.trim() !== '');
    assert.ok(next !== undefined, '标题后面应当还有内容');
    assert.doesNotMatch(next, /^\s*<p[\s>]/);
  });
}

const DEAD_RULES = [
  ['Overview.vue', /\.page-head p\b|\.section-head p\b/],
  ['DecisionHistory.vue', /\.page-head p\b/],
  ['ApprovalCenter.vue', /\.page-head p\b/],
  ['Waves.vue', /\.page-head p\b/],
  ['ToLand.vue', /\.page-head p\b/],
  ['Kanban.vue', /\.title-group p\b/],
  ['ParallelPlan.vue', /\.page-subtitle\b|\.sec-head p\b/],
];

for (const [file, pattern] of DEAD_RULES) {
  test(`${file} 不留只给已删段落用的样式规则`, () => {
    assert.doesNotMatch(styleOf(read(file)), pattern);
    assert.doesNotMatch(templateOf(read(file)), /page-subtitle/);
  });
}

test('并行派单页的重新算按钮带悬浮提示', () => {
  assert.ok(templateOf(read('ParallelPlan.vue')).includes('<button class="btn btn-sm" type="button" title="本机计算，不花额度" :disabled="loading" @click="load">'));
});
