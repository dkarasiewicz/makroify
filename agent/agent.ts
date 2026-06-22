import { defineAgent } from "eve";

/**
 * Makro shopping assistant. A small, cheap model is plenty for "find product →
 * tweak cart" chat. Override with EVE_MODEL (e.g. a stronger model in prod).
 */
export default defineAgent({
  model: process.env.EVE_MODEL ?? "anthropic/claude-haiku-4.5",
});
