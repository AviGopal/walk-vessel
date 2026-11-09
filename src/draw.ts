// SPDX-License-Identifier: MIT
export type Post = { alpha: number; beta: number }

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
  let best = 0
  let top = -Infinity
  posts.forEach((p, i) => {
    const x = beta(p.alpha, p.beta)
    if (x > top) {
      best = i
      top = x
    }
  })
  return best
}
