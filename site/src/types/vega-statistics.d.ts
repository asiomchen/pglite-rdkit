// vega-statistics ships without type declarations; these are the functions Performance.tsx uses
declare module 'vega-statistics' {
  /** Percentile bootstrap confidence interval of the mean: [lower, upper] */
  export function bootstrapCI(values: number[], samples: number, alpha: number): [number, number]
  /** Replaces the random number generator the package (and Vega's aggregates) draw from */
  export function setRandom(random: () => number): void
  /** A seeded linear congruential generator */
  export function randomLCG(seed: number): () => number
}
