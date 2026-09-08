'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function runTs(code) {
  const setup = `
    import { dependencySubgraph, layerOf, layeredLayout } from './web/src/utils/graphLayout.ts'
    const task = (id, extra = {}) => ({ id, title: id, status: '施工中', ...extra })
    const edge = (source, target, kind = 'dependsOn') => ({ source, target, kind })
  `;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', setup + code], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  return JSON.parse(result.stdout.trim());
}

test('默认关系子图保留活跃依赖与一跳邻居，包括已完工前置卡，禁止扩到第二跳', () => {
  const result = runTs(`
    const tasks = [
      task('A', { deps: { relatedTasks: ['SIDE'] } }),
      task('B', { deps: { dependsOn: ['A', 'D', 'MISSING'], blockedBy: ['C'], relatedTasks: ['R'] } }),
      task('C'), task('D', { status: '已完工', deps: { dependsOn: ['OLD'] } }),
      task('R', { status: '已完工', deps: { relatedTasks: ['B', 'FAR'] } }),
      task('SIDE', { status: '已作废' }), task('OLD', { status: '已完工' }), task('FAR', { status: '已完工' }),
      task('LONE'), task('RELATED-ONLY', { deps: { relatedTasks: ['LONE'] } }),
      task('ARCHIVED', { status: '已完工' }),
    ]
    const before = JSON.stringify(tasks)
    const graph = dependencySubgraph(tasks, { showAll: false })
    console.log(JSON.stringify({ nodes: graph.nodes.map(t => t.id), edges: graph.edges,
      all: dependencySubgraph(tasks, { showAll: true }).nodes.map(t => t.id), unchanged: JSON.stringify(tasks) === before }))
  `);
  assert.deepEqual(result.nodes, ['A', 'B', 'C', 'D', 'R', 'SIDE']);
  assert.deepEqual(result.edges, [
    { source: 'A', target: 'SIDE', kind: 'related' },
    { source: 'A', target: 'B', kind: 'dependsOn' },
    { source: 'D', target: 'B', kind: 'dependsOn' },
    { source: 'C', target: 'B', kind: 'blockedBy' },
    { source: 'B', target: 'R', kind: 'related' },
  ]);
  assert.deepEqual(result.all, ['A', 'B', 'C', 'D', 'R', 'SIDE', 'OLD', 'FAR', 'LONE', 'RELATED-ONLY', 'ARCHIVED']);
  assert.equal(result.unchanged, true);
});

test('focus 只留目标及上下游一跳并标高亮，返回副本不污染卡片', () => {
  const result = runTs(`
    const tasks = Object.freeze([
      task('A'), task('B', { deps: { dependsOn: ['A'] } }), task('C', { deps: { blockedBy: ['B'] } }),
      task('D', { deps: { dependsOn: ['C'] } }), task('LONE'),
    ].map(Object.freeze))
    const graph = dependencySubgraph(tasks, { showAll: false, focusId: 'B' })
    console.log(JSON.stringify({ nodes: graph.nodes.map(t => [t.id, t.highlighted]), edges: graph.edges,
      unchanged: tasks.every(t => !Object.hasOwn(t, 'highlighted')),
      missing: dependencySubgraph(tasks, { showAll: true, focusId: 'missing' }).nodes,
      lone: dependencySubgraph(tasks, { showAll: true, focusId: 'LONE' }).nodes.map(t => t.id) }))
  `);
  assert.deepEqual(result.nodes, [['A', true], ['B', true], ['C', true]]);
  assert.deepEqual(result.edges, [{ source: 'A', target: 'B', kind: 'dependsOn' }, { source: 'B', target: 'C', kind: 'blockedBy' }]);
  assert.equal(result.unchanged, true);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.lone, ['LONE']);
});

test('非零波次决定左右层级，缺波次按零，层间等距', () => {
  const result = runTs(`
    const nodes = [task('A', { wave: 3 }), task('B', { wave: 1 }), task('C'), task('D', { wave: -1 })]
    const edges = [edge('A', 'D')]
    console.log(JSON.stringify({ layers: Object.fromEntries(layerOf(nodes, edges)),
      points: Object.fromEntries(layeredLayout(nodes, edges, { width: 1000, height: 600 })) }))
  `);
  assert.deepEqual(result.layers, { A: 3, B: 1, C: 0, D: -1 });
  assert.deepEqual(result.points, { D: { x: 200, y: 300 }, C: { x: 400, y: 300 }, B: { x: 600, y: 300 }, A: { x: 800, y: 300 } });
});

test('全零波次按依赖和阻塞的最长拓扑路径分层，关联边与缺失节点不加深度', () => {
  const result = runTs(`
    const nodes = ['D', 'C', 'B', 'A', 'R'].map(id => task(id, { wave: 0 }))
    const edges = [edge('A', 'B'), edge('B', 'C', 'blockedBy'), edge('A', 'D'), edge('C', 'D'), edge('D', 'R', 'related'), edge('MISSING', 'A')]
    console.log(JSON.stringify(Object.fromEntries(layerOf(nodes, edges))))
  `);
  assert.deepEqual(result, { A: 0, B: 1, C: 2, D: 3, R: 0 });
});

test('依赖环和自环按发现顺序断回边，可重复得到有限层级', () => {
  const result = runTs(`
    const nodes = ['A', 'B', 'C', 'S'].map(id => task(id))
    const edges = [edge('C', 'A'), edge('A', 'B'), edge('B', 'C'), edge('S', 'S')]
    console.log(JSON.stringify({ first: Object.fromEntries(layerOf(nodes, edges)), second: Object.fromEntries(layerOf(nodes, edges)),
      points: [...layeredLayout(nodes, edges, { width: 800, height: 600 }).values()].every(p => Number.isFinite(p.x) && Number.isFinite(p.y)) }))
  `);
  assert.deepEqual(result.first, { B: 0, C: 1, A: 2, S: 0 });
  assert.deepEqual(result.second, result.first);
  assert.equal(result.points, true);
});

test('同层按卡号排序且纵向均匀，保留输入次序，空图和单卡可布局', () => {
  const result = runTs(`
    const nodes = Object.freeze(['C', 'A', 'B'].map(id => Object.freeze(task(id, { wave: 2 }))))
    console.log(JSON.stringify({ points: Object.fromEntries(layeredLayout(nodes, [], { width: 800, height: 600 })),
      input: nodes.map(t => t.id), empty: layeredLayout([], [], { width: 800, height: 600 }).size,
      lone: Object.fromEntries(layeredLayout([task('ONLY')], [], { width: 800, height: 600 })),
      defaultEmpty: dependencySubgraph([task('LONE')], { showAll: false }) }))
  `);
  assert.deepEqual(result.points, { A: { x: 400, y: 150 }, B: { x: 400, y: 300 }, C: { x: 400, y: 450 } });
  assert.deepEqual(result.input, ['C', 'A', 'B']);
  assert.equal(result.empty, 0);
  assert.deepEqual(result.lone, { ONLY: { x: 400, y: 300 } });
  assert.deepEqual(result.defaultEmpty, { nodes: [], edges: [] });
});
