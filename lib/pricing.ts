// Token prices used for the cost estimate. Defaults match the published Gemini 3.5 Transcribe rates
// when this was written; override them with environment variables when Google changes its prices.

export type Pricing = { inputPerMillion: number; outputPerMillion: number; source: "default" | "environment" };

const DEFAULT_INPUT = 2;
const DEFAULT_OUTPUT = 12;

function positiveNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function getPricing(): Pricing {
  const input = positiveNumber(process.env.GEMINI_INPUT_USD_PER_MILLION);
  const output = positiveNumber(process.env.GEMINI_OUTPUT_USD_PER_MILLION);
  return {
    inputPerMillion: input ?? DEFAULT_INPUT,
    outputPerMillion: output ?? DEFAULT_OUTPUT,
    source: input !== undefined || output !== undefined ? "environment" : "default",
  };
}

export type TokenUsage = { inputTokens: number; outputTokens: number; thoughtTokens: number };

/** Input tokens at the input rate; output and thinking tokens at the output rate. */
export function costUsd(usage: TokenUsage, pricing: Pricing = getPricing()): number {
  const cost =
    (usage.inputTokens * pricing.inputPerMillion + (usage.outputTokens + usage.thoughtTokens) * pricing.outputPerMillion) / 1_000_000;
  return Number(cost.toFixed(8));
}
