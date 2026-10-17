'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { builtinModules } = require('node:module')
const root = __dirname
// Absolute package-local lookup is intentional: never borrow a parent's compiler.
const ts = require(path.join(root, 'node_modules/typescript'))
if (ts.version !== '6.0.3') throw new Error(`Expected locked TypeScript 6.0.3, found ${ts.version}`)
const sourceRoot = path.join(root, 'src')
const outputRoot = path.join(root, 'dist')
const generator = require('./src/sched/sched-client-bundle.cjs')
const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]))

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name)
    if (entry.isSymbolicLink()) throw new Error(`Symlink in source: ${file}`)
    return entry.isDirectory() ? walk(file) : [file]
  })
}
const files = walk(sourceRoot)
// Validate real source imports before creating any output. Client factories are
// generated separately from their own package-local source closure below.
for (const file of files.filter(f => /\.(ts|cjs)$/.test(f) && !/\.d\.cts$/.test(f))) {
  const parsed = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  function visit(node) {
    let ref
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) ref = node.moduleSpecifier.text
    if (ts.isCallExpression(node) && node.expression.getText(parsed) === 'require' && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) ref = node.arguments[0].text
    if (ref && !builtins.has(ref)) {
      if (ref === 'typescript' && file.endsWith('sched-client-bundle.cjs')) return
      if (!ref.startsWith('.')) throw new Error(`External runtime dependency: ${ref} in ${file}`)
      const resolved = path.resolve(path.dirname(file), ref)
      const rel = path.relative(sourceRoot, resolved)
      if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`Import escapes package source: ${ref}`)
      if (!['', '.ts', '.cjs', '.d.cts'].some(ext => fs.existsSync(resolved + ext))
        && !(resolved.endsWith('.js') && fs.existsSync(resolved.slice(0, -3) + '.ts'))
        && !resolved.endsWith('sched-suspend-native-assets')) throw new Error(`Unresolved source import: ${ref} in ${file}`)
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
}
function importMeta(context) {
  const f = context.factory
  function visit(node) {
    if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
      return f.createObjectLiteralExpression([f.createPropertyAssignment('url',
        f.createPropertyAccessExpression(f.createCallExpression(
          f.createPropertyAccessExpression(f.createCallExpression(f.createIdentifier('require'), undefined, [f.createStringLiteral('node:url')]), 'pathToFileURL'),
          undefined, [f.createIdentifier('__filename')]), 'href'))])
    }
    return ts.visitEachChild(node, visit, context)
  }
  return node => ts.visitNode(node, visit)
}
function compile(source, file) {
  const result = ts.transpileModule(source, {
    fileName: file, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    transformers: { before: [importMeta] },
  })
  const errors = (result.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error)
  if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, { getCurrentDirectory: () => root, getCanonicalFileName: f => f, getNewLine: () => '\n' }))
  return result.outputText
}
// Only this package's dist is removed; source and caller data are never touched.
fs.rmSync(outputRoot, { recursive: true, force: true })
for (const file of files) {
  const relative = path.relative(sourceRoot, file)
  if (relative.endsWith('sched-client-bundle.cjs')) continue
  const target = path.join(outputRoot, relative.replace(/(?<!\.d)\.ts$/, '.js'))
  fs.mkdirSync(path.dirname(target), { recursive: true })
  let source = fs.readFileSync(file)
  if (file.endsWith('.ts') && !file.endsWith('.d.cts')) source = compile(source.toString('utf8'), file)
  if (relative.replaceAll('\\', '/') === 'sched/client/sched.cjs') source = generator.generatedClient(source.toString('utf8'))
  fs.writeFileSync(target, source)
}
fs.writeFileSync(path.join(outputRoot, 'sched/sched-suspend-native-assets.js'), compile(generator.assets(), 'sched-suspend-native-assets.ts'))
console.log(`scheduler build: ${files.length} package-local source files; TypeScript ${ts.version}; no runtime npm dependencies`)
