type ModelPricing = {
  [key: string]: number
}

const originalPricing: ModelPricing = {
  "gpt-3.5-turbo": 0.002,
  "gpt-4": 0.03,
  "gpt-4-32k": 0.06,
  "gpt-4o": 0.01,
}

export const discountedPricing: ModelPricing = Object.entries(originalPricing).reduce((acc, [model, price]) => {
  acc[model] = price * 0.75 // 25% discount
  return acc
}, {} as ModelPricing)

export function calculateCost(model: string, tokens: number): number {
  const pricePerToken = discountedPricing[model] || discountedPricing["gpt-4o"]
  return (pricePerToken * tokens) / 1000 // Price is per 1000 tokens
}

