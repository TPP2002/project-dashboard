'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const source = path.resolve(__dirname, '../packages/scheduler')

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    assert.equal(entry.isSymbolicLink(), false, `symlink in package: ${entry.name}`)
    const file = path.join(dir, entry.name)
    return entry.isDirectory() ? files(file) : [file]
  })
}
function contained(parent, target) {
  const relative = path.relative(parent, target)
  return !relative.startsWith('..') && !path.isAbsolute(relative)
}

// One file, serial execution. Its npm install/build and runtime children inherit
// the dispatcher's scheduling permit; there is no fallback to a sibling checkout.
test('standalone scheduler builds and executes its actual ledger state machine in isolation', { timeout: 180000 }, () => {
  assert.ok(Number(process.versions.node.split('.')[0]) >= 24, 'Node 24 or newer is required')
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-scheduler-package-'))
  const pkg = path.join(sandbox, 'package')
  let completed = false
  const env = { ...process.env, NODE_OPTIONS: '', npm_config_audit: 'false', npm_config_fund: 'false',
    npm_config_cache: path.join(sandbox, 'npm-cache'), LOCALAPPDATA: path.join(sandbox, 'local-state') }
  for (const key of Object.keys(env)) if (['NODE_PATH', 'SCHED_CONFIG', 'SCHED_SHARE', 'DASHBOARD_SCHED_SHARE'].includes(key.toUpperCase())) delete env[key]
  function run(label, executable, args) {
    const result = spawnSync(executable, args, { cwd: pkg, env, encoding: 'utf8', timeout: 120000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
    const raw = `${result.stdout ?? ''}${result.stderr ?? ''}`
    fs.writeFileSync(path.join(sandbox, `${label}.log`), raw)
    assert.ifError(result.error)
    assert.equal(result.status, 0, `${label} failed; original output retained at ${sandbox}\n${raw}`)
    return raw
  }
  try {
    fs.cpSync(source, pkg, { recursive: true, filter: file => !['node_modules', 'dist', '.npm-cache'].includes(path.basename(file)) })
    const forbidden = [
      /(?<![A-Za-z])[A-Z]:[\\/](?!\/)/i,
      /\b(?:\d{1,3}\.){3}\d{1,3}\b/,
      /(?:stock-rogue|calib-share|DESKTOP-[A-Z0-9]{7}|Dx-\d{12}|SSUN-[A-Z]+|github:[A-Za-z0-9_-]+\/)/i,
      /tk-[0-9a-f]{20}/,
    ]
    for (const file of files(pkg)) {
      const text = fs.readFileSync(file, 'utf8')
      for (const pattern of forbidden) assert.doesNotMatch(text, pattern, `private deployment data in ${path.relative(pkg, file)}`)
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(pkg, 'package.json')))
    assert.deepEqual(manifest.dependencies ?? {}, {})
    assert.deepEqual(manifest.devDependencies, { typescript: '6.0.3' })
    const lock = JSON.parse(fs.readFileSync(path.join(pkg, 'package-lock.json')))
    assert.deepEqual(Object.keys(lock.packages).sort(), ['', 'node_modules/typescript'])
    assert.equal(lock.packages['node_modules/typescript'].version, '6.0.3')
    assert.equal(fs.existsSync(path.join(pkg, 'node_modules')), false)
    run('install', process.platform === 'win32' ? 'cmd.exe' : 'npm', process.platform === 'win32'
      ? ['/d', '/s', '/c', 'npm ci --ignore-scripts --no-audit --no-fund'] : ['ci', '--ignore-scripts', '--no-audit', '--no-fund'])
    // The package compiler's AST audits every source import, not just filenames.
    run('build', process.execPath, ['build.cjs'])
    const published = JSON.parse(fs.readFileSync(path.join(pkg, 'SOURCES.json')))
    assert.ok(published.length > 50)
    for (const entry of published) assert.equal(entry.revision, '20cea25479bff56cc7d386be2c8d103fd0c446fb')
    // All generated executable modules parse as production Node JS; no TS loader.
    for (const file of files(path.join(pkg, 'dist')).filter(f => /\.(js|cjs)$/.test(f))) {
      run('syntax', process.execPath, ['--check', file])
    }
    assert.equal(contained(sandbox, path.join(pkg, 'node_modules')), true)
    fs.rmSync(path.join(pkg, 'node_modules'), { recursive: true, force: true })
    run('help', process.execPath, [path.join(pkg, 'dist/cli.cjs'), 'help'])
    run('validate-config', process.execPath, [path.join(pkg, 'dist/cli.cjs'), 'validate-config', '--config', path.join(pkg, 'config.example.json')])
    const fixture = path.join(pkg, 'fixtures/isolated-runtime.cjs')
    run('runtime', process.execPath, [fixture, pkg, sandbox])
    completed = true
  } finally {
    if (completed) {
      assert.equal(path.dirname(sandbox), path.resolve(os.tmpdir()))
      assert.ok(path.basename(sandbox).startsWith('cloud-scheduler-package-'))
      fs.rmSync(sandbox, { recursive: true, force: true })
    } else console.error(`NOT_PROVEN: original isolated install/build/runtime evidence preserved at ${sandbox}`)
  }
})
