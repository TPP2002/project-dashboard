// mulberry32：所有试听顺序、间隔和速率抖动都由显示在页面上的种子导出。
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let n = Math.imul(state ^ (state >>> 15), 1 | state)
    n ^= n + Math.imul(n ^ (n >>> 7), 61 | n)
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296
  }
}
export function blindOrder<T>(values: readonly T[], seed: number): T[] {
  const result = [...values], random = seededRandom(seed)
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}
export function blindLabel(index: number, noun: string): string {
  if (noun === '候选') return String(index + 1)
  const alphabet = 'XYZABCDEFGHIJKLMNOPQRSTUVW'
  return alphabet[index % 26] + (index >= 26 ? String(Math.floor(index / 26) + 1) : '')
}
