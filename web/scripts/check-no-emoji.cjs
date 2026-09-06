#!/usr/bin/env node
// 验收闸：web/src 里不许再出现 emoji 码点。
//
// 「emoji」的判据取 Unicode 的 Extended_Pictographic（外加变体选择符 U+FE0F）——
// 也就是「会被系统渲染成彩色图形的那一族字」。数学与排版符号（→ ≈ ≤ ∈ − ①②③）、
// 几何记号（● ○ ✓ ✕）不在其内：它们是排版用字，不是图标，替成 SVG 反而更糟。
//
// 用法：node web/scripts/check-no-emoji.cjs   （有残留则退出码 1 并列出行号）
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..', 'src')
const EMOJI = /(\p{Extended_Pictographic}|️)/u

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

const hits = []
for (const file of walk(ROOT)) {
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, index) => {
    const found = [...line].filter(ch => EMOJI.test(ch))
    if (found.length) hits.push({ file: path.relative(path.resolve(__dirname, '..', '..'), file), line: index + 1, chars: [...new Set(found)].join(' '), text: line.trim().slice(0, 100) })
  })
}

if (!hits.length) {
  console.log('✔ web/src 无 emoji 码点')
  process.exit(0)
}
console.error(`✘ 还有 ${hits.length} 处 emoji 残留：`)
for (const hit of hits) console.error(`  ${hit.file}:${hit.line}  [${hit.chars}]  ${hit.text}`)
process.exit(1)
