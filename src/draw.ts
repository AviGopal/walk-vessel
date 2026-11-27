// SPDX-License-Identifier: MIT
// from: which level of evidence records drew the posterior from (its cell, or a coarser one it backed off to).
export type Post = { alpha: number; beta: number; from?: string }

// Which of n to take, uniformly, from a seed: the same seed always takes the same one. A different stream from draw()'s
// own, so taking a root and then drawing a move within it are not tied to each other.
export const pick = (seed: number, n: number): number => {
  let t = Math.imul((seed ^ 0x9e3779b9) | 0, 0x85ebca6b)
  t = Math.imul(t ^ (t >>> 13), 0xc2b2ae35)
  return Math.floor((((t ^ (t >>> 16)) >>> 0) / 4294967296) * n)
}

export const draw = (seed: number, posts: Post[]): number => {
  let s = seed | 0
  const u = (): number => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const normal = (): number => {
    const u1 = 1 - u()
    const u2 = u()
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
  }
  const gamma = (a: number): number => {
    if (a < 1) {
      const g = gamma(a + 1)
      return g * Math.pow(u(), 1 / a)
    }
    const d = a - 1 / 3
    const c = 1 / Math.sqrt(9 * d)
    while (true) {
      const x = normal()
      const v = Math.pow(1 + c * x, 3)
      if (v <= 0) {
        continue
      }
      const w = u()
      if (w < 1 - 0.0331 * x * x * x * x) {
        return d * v
      }
      if (Math.log(w) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
        return d * v
      }
    }
  }
  const beta = (alpha: number, b: number): number => {
    const x = gamma(alpha)
    const y = gamma(b)
    return x / (x + y)
  }
  if (posts.length <= 1) return 0
  const M = 64
  const n = posts.length
  const samples: number[][] = []
  const winCount = new Array<number>(n).fill(0)
  let thetaStarSum = 0
  for (let m = 0; m < M; m++) {
    const row = new Array<number>(n)
    let rowMax = -Infinity
    let rowArg = 0
    for (let i = 0; i < n; i++) {
      const p = posts[i]
      const x = beta(p.alpha, p.beta)
      row[i] = x
      if (x > rowMax) {
        rowMax = x
        rowArg = i
      }
    }
    samples.push(row)
    winCount[rowArg]++
    thetaStarSum += rowMax
  }
  const unanimous = winCount.indexOf(M)
  if (unanimous >= 0) return unanimous
  const thetaStarMean = thetaStarSum / M
  const binEntropy = (p: number): number =>
    p <= 1e-12 || p >= 1 - 1e-12 ? 0 : -p * Math.log(p) - (1 - p) * Math.log(1 - p)
  let best = 0
  let bestPsi = Number.POSITIVE_INFINITY
  let bestMu = -Infinity
  for (let i = 0; i < n; i++) {
    let muSum = 0
    let entSum = 0
    for (let m = 0; m < M; m++) {
      const x = samples[m][i]
      muSum += x
      entSum += binEntropy(x)
    }
    const mu = muSum / M
    const delta = Math.max(0, thetaStarMean - mu)
    const ig = Math.max(0, binEntropy(mu) - entSum / M)
    const psi = delta <= 1e-12 ? 0 : ig <= 1e-12 ? Number.POSITIVE_INFINITY : (delta * delta) / ig
    if (psi < bestPsi || (psi === bestPsi && mu > bestMu)) {
      best = i
      bestPsi = psi
      bestMu = mu
    }
  }
  return best
}
