const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const { resolve } = require('node:path')
const { pathToFileURL } = require('node:url')
const { STATUS } = require('../core/boardSchema.cjs')

const ROOT = resolve(__dirname, '..')
// 只补 Vite 的模块解析，不替换被测 bridge、derive 或 schema 的实现。
const schemaUrl = 'data:text/javascript,' + encodeURIComponent('export const STATUS = ' + JSON.stringify(STATUS))
// derive.ts 还引 virtual:decision-landing（决策落地口径，AUD-UI-UNLANDED-DERIVE），同样只补解析、不替换实现。
const landingUrl = 'data:text/javascript,' + encodeURIComponent(require('../core/decisionLanding.cjs').toEsmSource())
const loaderUrl = 'data:text/javascript,' + encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === 'virtual:board-schema') return { url: ${JSON.stringify(schemaUrl)}, shortCircuit: true }
    if (specifier === 'virtual:decision-landing') return { url: ${JSON.stringify(landingUrl)}, shortCircuit: true }
    return nextResolve(specifier, context)
  }
`)

function runTs(code) {
  const setup = `
    import { register } from 'node:module';
    register(${JSON.stringify(loaderUrl)}, ${JSON.stringify(pathToFileURL(ROOT + '/').href)});
    const { deriveSceneState, mapBoardEvent } = await import('./web/src/workfloor/bridge.ts');
    const { progress } = await import('./web/src/utils/derive.ts');
  `
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', setup + code], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, TSX_TSCONFIG_PATH: resolve(ROOT, 'web/tsconfig.json') },
  })
  assert.equal(result.status, 0, '桥接子进程失败:\n' + result.stderr)
  return JSON.parse(result.stdout.trim())
}

const board = tasks => ({ schemaVersion: '1', project: { id: 'p', name: '项目' }, tasks })
const task = (id, status, extra = {}) => ({ id, title: id, status, ...extra })

test('十一种状态全部归组，压轴置底，收官至少九成，作废剔除', () => {
  const input = board([
    task('Q2', '未开工', { wave: 2 }), task('Q1', '待开工', { wave: 1 }),
    task('Q3', '可复工', { wave: 2 }), task('Z', '压轴', { wave: -1 }),
    task('A2', '施工中', { dates: { claimed: '2026-09-08T10:00:00Z' } }),
    task('A1', '已拍板', { dates: { claimed: '2026-09-08T09:00:00Z' } }),
    task('A3', '收官', { percent: 20 }), task('P', '待拍板'), task('B', '暂缓'),
    task('D', '已完工'), task('V', '已作废'),
  ])
  assert.deepEqual([...new Set(input.tasks.map(t => t.status))].sort(), [...STATUS].sort())
  const out = runTs(`const b=${JSON.stringify(input)}; const before=JSON.stringify(b);
    const state=deriveSceneState(b,'p'); console.log(JSON.stringify({state,progress:progress(b),unchanged:before===JSON.stringify(b)}));`)
  assert.deepEqual(out.state.queued.map(t => t.id), ['Q1', 'Q2', 'Q3', 'Z'])
  assert.deepEqual(out.state.active.map(t => t.id), ['A1', 'A2', 'A3'])
  assert.deepEqual(out.state.pending.map(t => t.id), ['P'])
  assert.deepEqual(out.state.blocked.map(t => t.id), ['B'])
  assert.deepEqual(out.state.done.map(t => t.id), ['D'])
  assert.equal(out.state.active[2].percent, 90)
  assert.deepEqual(out.state.queued.map(t => t.order), [0, 1, 2, 3])
  assert.equal(out.state.total, 10)
  assert.equal(out.state.percent, 10)
  assert.equal(out.state.complete, false)
  assert.equal(out.state.percent, out.progress.percent)
  assert.equal(out.unchanged, true)
})

test('进度夹到整数边界，缺省与脏值归零，收官保留高于九成的值', () => {
  const out = runTs(`const values=[undefined,-8,128,32.7,NaN,Infinity,'60'];
    const tasks=values.map((percent,i)=>({id:String(i),title:'卡',status:'施工中',percent}));
    tasks.push({id:'wrap',title:'收官',status:'收官',percent:96});
    console.log(JSON.stringify(deriveSceneState({project:{name:'项目'},tasks},'p').active.map(t=>t.percent)));`)
  assert.deepEqual(out, [0, 0, 100, 33, 0, 0, 0, 96])
})

test('完工按日期再按编号排序；空、全作废不触发完成，全部完工才完成', () => {
  const boards = [null, board([]), board([task('V', '已作废')]),
    board([task('D2', '已完工', { dates: { done: '2026-09-08' } }),
      task('D1', '已完工', { dates: { done: '2026-09-07' } }), task('V', '已作废')])]
  const out = runTs(`console.log(JSON.stringify(${JSON.stringify(boards)}.map(b=>deriveSceneState(b,'p'))));`)
  assert.deepEqual(out.map(s => s.complete), [false, false, false, true])
  assert.deepEqual(out.map(s => s.percent), [0, 0, 0, 100])
  assert.deepEqual(out[3].done.map(t => t.id), ['D1', 'D2'])
})

test('事件映射表全覆盖，总线进度读当前状态，异项目事件丢弃', () => {
  const out = runTs(`
    const state=deriveSceneState(${JSON.stringify(board([task('T', '施工中', { percent: 62 })]))},'p');
    const event={projectId:'p',taskId:'T',ts:'2026-09-08T09:00:00Z'};
    const kinds=['claim','progress','pending','decide','block','park','done','note'];
    console.log(JSON.stringify({mapped:kinds.map(kind=>mapBoardEvent({...event,kind},'p',state)),
      other:mapBoardEvent({...event,kind:'done',projectId:'other'},'p',state),
      direct:mapBoardEvent({...event,kind:'progress',percent:125}),
      absent:mapBoardEvent({...event,kind:'progress'})}));`)
  assert.deepEqual(out.mapped.map(e => e?.kind ?? null), ['claim', 'progress', 'hold', 'go', 'block', 'park', 'done', null])
  assert.equal(out.mapped[1].percent, 62)
  assert.equal(out.mapped[0].taskId, 'T')
  assert.equal(out.mapped[0].projectId, 'p')
  assert.equal(out.mapped[0].ts, '2026-09-08T09:00:00Z')
  assert.equal(out.other, null)
  assert.equal(out.direct.percent, 100)
  assert.equal(out.absent.percent, 0)
})

test('机甲大屏按通电、待拍板、施工、阻塞、待机排列且选中对应任务', () => {
  const inputs = [board([task('D', '已完工')]),
    board([task('A', '施工中'), task('P', '待拍板'), task('B', '暂缓')]),
    board([task('A', '施工中'), task('B', '暂缓')]), board([task('B', '暂缓')]), board([])]
  const out = runTs(`
    const { projectAssembly, actionLabel } = await import('./web/src/workfloor/scenes/mech/assembly.ts');
    console.log(JSON.stringify(${JSON.stringify(inputs)}.map(b=>{
      const assembly=projectAssembly(deriveSceneState(b,'p'));
      return {mode:assembly.mode,task:assembly.task?.id??null,label:actionLabel(assembly)};
    })));
  `)
  assert.deepEqual(out.map(value => value.mode), ['powered', 'pend', 'build', 'block', 'ready'])
  assert.deepEqual(out.map(value => value.task), [null, 'P', 'A', 'B', null])
  assert.equal(out[0].label, 'POWER ON')
  assert.equal(out[1].label, 'INSPECT?')
  assert.match(out[2].label, /^WELDING [A-Z]+$/)
  assert.equal(out[3].label, 'JAMMED')
  assert.equal(out[4].label, 'STANDBY')
})

test('转运与夹合期间维持 ROLLOUT，其他暂缓卡的刷新不取消转运', () => {
  const initial = board([task('A', '施工中', { percent: 62 }), task('B', '暂缓')])
  const out = runTs(`
    const { createSequence } = await import('./web/src/workfloor/scenes/launch/sequence.ts');
    const state=deriveSceneState(${JSON.stringify(initial)},'p'), seq=createSequence(state);
    seq.handleEvent({kind:'claim',projectId:'p',taskId:'A',ts:'2026-09-08T09:00:00Z'},true);
    seq.setState({...state}); const first=seq.frame().phase;
    for(let i=0;i<58;i++) seq.tick(100); seq.tick(99); const before=seq.frame().phase;
    seq.tick(1); const after=seq.frame().phase;
    const clean=createSequence({...state,blocked:[]}); clean.handleEvent({kind:'claim',projectId:'p',taskId:'A',ts:'2026-09-08T09:00:01Z'},true);
    for(let i=0;i<59;i++) clean.tick(100);
    console.log(JSON.stringify({first,before,after,clean:clean.frame().phase}));
  `)
  assert.deepEqual(out, { first: 'ROLLOUT', before: 'ROLLOUT', after: 'FUEL', clean: 'FUEL' })
})

test('起飞队列保留旧快照和同秒后续完工，结束后才通报全部完成，烟四秒后清空', () => {
  const initial = board([task('A', '施工中', { percent: 96 }), task('B', '施工中', { percent: 30 })])
  const out = runTs(`
    const { createSequence } = await import('./web/src/workfloor/scenes/launch/sequence.ts');
    const initial=deriveSceneState(${JSON.stringify(initial)},'p'), cues=[], seq=createSequence(initial,cue=>cues.push(cue));
    const event={kind:'done',projectId:'p',taskId:'A',ts:'2026-09-08T09:00:00Z'};
    const firstFrame=seq.frame(); seq.handleEvent(event,true); seq.setState({...initial});
    seq.tick(100); const stale=seq.frame();
    const done={...initial,active:[],done:initial.active.map(task=>({...task,status:'已完工'})),percent:100,complete:true};
    seq.setState(done); seq.handleEvent({...event,taskId:'B'},false);
    seq.handleEvent({...event,kind:'complete',taskId:''},true); const running=seq.frame();
    for(let i=0;i<33;i++) seq.tick(100); const finished=seq.frame();
    for(let i=0;i<40;i++) seq.tick(100);
    const refresh=createSequence(done).frame();
    console.log(JSON.stringify({firstFrame,stale,running,finished,cleared:seq.frame().smokeAge,refresh,cues}));
  `)
  assert.equal(out.firstFrame.flightAge, null)
  assert.equal(out.firstFrame.phase, 'FUEL')
  assert.equal(out.stale.flightAge, 100)
  assert.equal(out.running.phase, 'LIFTOFF')
  assert.equal(out.running.task.id, 'A')
  assert.equal(out.running.launchId, 1)
  assert.equal(out.running.completeAge, null)
  assert.equal(out.running.state.done.length, 2)
  assert.equal(out.finished.phase, 'COMPLETE')
  assert.equal(out.finished.flightAge, null)
  assert.equal(out.finished.completeAge, 0)
  assert.equal(out.cleared, null)
  assert.equal(out.refresh.flightAge, null)
  assert.equal(out.refresh.completeAge, null)
  assert.deepEqual(out.cues, ['ignition', 'liftoff', 'complete'])
})

test('发射台按施工、待拍板、暂缓选首枚，大屏和倒计时只读所选分组', () => {
  const a = task('A', '施工中', { percent: 55 }), p = task('P', '待拍板'), b = task('B', '暂缓')
  const inputs = [[a, b], [a, p, b], [p, b], [b], [task('Q', '未开工')], [], [task('D', '已完工')],
    [task('G', '已拍板', { percent: 95 }), p, b], [task('F', '施工中', { percent: 95 }), b]]
  const out = runTs(`
    const { createSequence } = await import('./web/src/workfloor/scenes/launch/sequence.ts');
    console.log(JSON.stringify(${JSON.stringify(inputs.map(board))}.map(input=>{
      const frame=createSequence(deriveSceneState(input,'p')).frame();
      return [frame.task?.id??null,frame.phase,frame.fuel,frame.countdown];
    })));
  `)
  assert.deepEqual(out, [['A', 'FUEL', 55, null], ['A', 'FUEL', 55, null], ['P', 'HOLD', 0, 10],
    ['B', 'SCRUB', 0, null], [null, 'READY', 0, null], [null, 'READY', 0, null],
    [null, 'COMPLETE', 0, null], ['G', 'GO', 95, 10], ['F', 'FUEL', 95, 10]])
})

test('阻塞和待拍板提示只播一次四秒，到期按最新台上分组恢复', () => {
  const a = task('A', '施工中', { percent: 55 }), p = task('P', '待拍板'), b = task('B', '暂缓')
  const cases = [['block', 'B', [a, p, b]], ['hold', 'B', [a, p, b]], ['hold', 'P', [a, p, b]],
    ['hold', 'P', [p, b]], ['block', 'B', [b]]]
  const out = runTs(`
    const { createSequence } = await import('./web/src/workfloor/scenes/launch/sequence.ts');
    const results=${JSON.stringify(cases)}.map(([kind,taskId,tasks])=>{
      const state=deriveSceneState({tasks},'p'), cues=[], seq=createSequence(state,cue=>cues.push(cue));
      const event={kind,taskId,projectId:'p',ts:'2026-09-08T09:00:00Z'};
      seq.handleEvent(event,true); const first=seq.frame();
      for(let i=0;i<20;i++) seq.tick(100);
      seq.setState({...state}); seq.handleEvent(event,true);
      for(let i=0;i<19;i++) seq.tick(100); seq.tick(99); const before=seq.frame().phase;
      seq.tick(1); seq.setState({...state}); const after=seq.frame();
      return {first:[first.phase,first.task.id,first.stormAge,first.rainAge],before,after:after.phase,cues};
    });
    const state=deriveSceneState(${JSON.stringify(board([a, p, b]))},'p'), seq=createSequence(state);
    seq.handleEvent({kind:'block',taskId:'B',projectId:'p',ts:'2026-09-08T09:00:01Z'},true);
    seq.setState({...state,active:[]}); for(let i=0;i<40;i++) seq.tick(100);
    const latest=seq.frame(); console.log(JSON.stringify({results,latest:[latest.phase,latest.task.id]}));
  `)
  assert.deepEqual(out.results.map(row => row.first), [['SCRUB', 'A', -400, 0], ['HOLD', 'A', -400, 0],
    ['HOLD', 'A', -400, 0], ['HOLD', 'P', -400, 0], ['SCRUB', 'B', -400, 0]])
  assert.deepEqual(out.results.map(row => row.before), ['SCRUB', 'HOLD', 'HOLD', 'HOLD', 'SCRUB'])
  assert.deepEqual(out.results.map(row => row.after), ['FUEL', 'FUEL', 'FUEL', 'HOLD', 'SCRUB'])
  assert.deepEqual(out.results.map(row => row.cues), [['alarm'], ['hold'], ['hold'], ['hold'], ['alarm']])
  assert.deepEqual(out.latest, ['HOLD', 'P'])
})

test('其它卡的提示和停工不重置倒计时、转运、起飞或等待点火', () => {
  const input = board([task('A', '施工中', { percent: 95 }), task('C', '施工中', { percent: 20 }), task('P', '待拍板'), task('B', '暂缓')])
  const out = runTs(`
    const { createSequence } = await import('./web/src/workfloor/scenes/launch/sequence.ts');
    const state=deriveSceneState(${JSON.stringify(input)},'p');
    const event=(kind,taskId)=>({kind,taskId,projectId:'p',ts:'2026-09-08T09:00:00Z'});
    const advance=(seq,ms)=>{while(ms>0){const dt=Math.min(ms,100);seq.tick(dt);ms-=dt;}};
    const go=createSequence(state); go.handleEvent(event('go','A'),true); advance(go,2000);
    go.setState({...state}); go.handleEvent(event('park','B'),true); go.handleEvent(event('block','B'),true);
    advance(go,4000); const countdown=go.frame();
    const rollout=createSequence(state); rollout.handleEvent(event('claim','A'),true); advance(rollout,1000);
    rollout.handleEvent(event('hold','P'),true); rollout.setState({...state}); const moving=rollout.frame();
    advance(rollout,4899); const docking=rollout.frame(); advance(rollout,1); const docked=rollout.frame();
    const flight=createSequence(state); flight.handleEvent(event('done','A'),true); advance(flight,100);
    flight.handleEvent(event('block','B'),true); flight.setState({...state,active:state.active.slice(1),done:[state.active[0]]});
    advance(flight,100); const flying=flight.frame(); advance(flight,3200); const next=flight.frame();
    const request=createSequence(state); request.setTruckSafe(false); request.handleEvent(event('done','A'),true);
    request.handleEvent(event('block','B'),true); request.handleEvent(event('hold','P'),true);
    request.setState({...state}); advance(request,4000); const waiting=request.frame();
    request.setTruckSafe(true); request.tick(1); const released=request.frame();
    console.log(JSON.stringify({countdown,moving,docking,docked,flying,next,waiting,released}));
  `)
  assert.deepEqual([out.countdown.phase, out.countdown.countdown, out.countdown.task.id], ['GO', 4, 'A'])
  assert.deepEqual([out.moving.phase, out.moving.motionPhase, out.moving.carrying], ['HOLD', 'ROLLOUT', true])
  assert.deepEqual([out.docking.phase, out.docking.dockAge, out.docked.phase], ['ROLLOUT', 1899, 'FUEL'])
  assert.deepEqual([out.flying.phase, out.flying.motionPhase, out.flying.task.id, out.flying.flightAge], ['SCRUB', 'LIFTOFF', 'A', 200])
  assert.deepEqual([out.next.motionPhase, out.next.task.id, out.next.flightAge], ['ROLLOUT', 'C', null])
  assert.deepEqual([out.waiting.launchRequested, out.waiting.task.id, out.released.flightAge], [true, 'A', 0])
})

test('禁用动画、减少动效和切项目不残留事件天气，待拍板解除后恢复加注', () => {
  const input = board([task('A', '施工中', { percent: 55 }), task('P', '待拍板'), task('B', '暂缓')])
  const out = runTs(`
    const { createSequence } = await import('./web/src/workfloor/scenes/launch/sequence.ts');
    const state=deriveSceneState(${JSON.stringify(input)},'p'), cues=[], seq=createSequence(state,cue=>cues.push(cue));
    const event={kind:'block',taskId:'B',projectId:'p',ts:'2026-09-08T09:00:00Z'};
    seq.handleEvent(event,false); const quiet=seq.frame().phase;
    seq.handleEvent({...event,ts:'2026-09-08T09:00:01Z'},true); seq.setReducedMotion(true);
    seq.handleEvent({...event,kind:'hold',taskId:'P'},true); const reduced=seq.frame().phase;
    seq.setReducedMotion(false); for(let i=0;i<50;i++) seq.tick(100); const resumed=seq.frame().phase;
    seq.handleEvent({...event,ts:'2026-09-08T09:00:02Z'},true); seq.setState({...state,projectId:'other'});
    const switched=seq.frame().phase, pending=createSequence({...state,active:[]});
    pending.handleEvent({...event,kind:'hold',taskId:'P'},true); pending.setState(state);
    for(let i=0;i<40;i++) pending.tick(100);
    console.log(JSON.stringify({quiet,reduced,resumed,switched,cues,recovered:pending.frame().phase}));
  `)
  assert.deepEqual(out, { quiet: 'FUEL', reduced: 'FUEL', resumed: 'FUEL', switched: 'FUEL', cues: ['alarm', 'alarm'], recovered: 'FUEL' })
})
