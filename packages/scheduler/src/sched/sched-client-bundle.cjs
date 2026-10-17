/* eslint @typescript-eslint/no-require-imports: "off" */
'use strict'
// 只在施工时把数个 TS 模块转译进单文件发行件；不启动子进程，派单员不做构建。
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const modules = ['../sched/client/deployment-config.cjs', '../sched/client/sched-projects.cjs', '../sched/client/sched-menu.cjs', 'sched-suspend-policy', 'sched-ci-policy', 'sched-suspend-timing', 'sched-suspend-store', 'sched-suspend-native-assets',
  'sched-suspend-native', 'sched-suspend', 'sched-suspend-execution', 'sched-permit-ancestry', 'sched-permit-authority', '../bot/cluster-agent-ci-gate', '../bot/cluster-agent-ci-observer']
const begin = '// BEGIN GENERATED SUSPEND RUNTIME'
const end = '// END GENERATED SUSPEND RUNTIME'
function assets() {
  const sources = Object.fromEntries(['Windows原生接口.ps1', '进程树控制宿主.ps1', '许可归属核验.cs', '许可归属管道.cs'].map(name => [name,
    fs.readFileSync(path.join(__dirname, 'native', name), 'utf8').replace(/^\ufeff/, '').replace(/\r\n/g, '\n')]))
  return '/** 由 sched-client-bundle.cjs 从已移植的原生工具生成；禁止手改。 */\nexport const nativeSources: Record<string, string> = '
    + JSON.stringify(sources, null, 2) + '\n'
}
function bundle() {
  return begin + '\n/* eslint-disable -- 以下为上述 TS 正本的单文件发行代码，检查正本与生成一致性 */\n'
    + 'function createSuspendRuntime() {\nconst factories = {\n'
    + modules.map(name => JSON.stringify(name) + ': function(require, module, exports) {\n'
      + ts.transpileModule(name === 'sched-suspend-native-assets' ? assets() : fs.readFileSync(path.join(__dirname, name.endsWith('.cjs') ? name : name + '.ts'), 'utf8'),
        { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, removeComments: false } }).outputText + '\n}').join(',\n')
    + '\n};\nconst cache = {};\nfunction localRequire(ref, from = ".") {\nif (!ref.startsWith(".")) return require(ref);\n'
    + 'const id = require("node:path").posix.normalize(require("node:path").posix.join(require("node:path").posix.dirname(from), ref));\n'
    + 'if (!Object.hasOwn(factories, id)) throw new Error("未打入发行件的模块:" + id);\n'
    + 'if (!cache[id]) { const instance = { exports: {} }; cache[id] = instance; factories[id](ref => localRequire(ref, id), instance, instance.exports); }\n'
    + 'return cache[id].exports;\n}\nreturn { ...localRequire("./sched-suspend-execution"), ...localRequire("./sched-permit-ancestry"), ...localRequire("./sched-permit-authority") };\n}\n/* eslint-enable */\n' + end
}
function generatedClient(source) {
  const generated = bundle()
  const start = source.indexOf(begin), stop = source.indexOf(end)
  if (start < 0) return source + '\n' + generated + '\n'
  if (stop < start) throw new Error('客户端生成边界不完整')
  return source.slice(0, start) + generated + source.slice(stop + end.length)
}
module.exports = { assets, bundle, generatedClient }
if (require.main === module) {
  const client = path.join(__dirname, 'client', 'sched.cjs')
  fs.writeFileSync(path.join(__dirname, 'sched-suspend-native-assets.ts'), assets())
  fs.writeFileSync(client, generatedClient(fs.readFileSync(client, 'utf8')))
  process.stdout.write('挂起模块已转译进单文件客户端；未启动子进程。\n')
}
