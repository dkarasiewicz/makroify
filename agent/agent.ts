import { defineAgent } from "eve";

/**
 * Makro shopping assistant. Model is configurable via EVE_MODEL so the same
 * codebase can run a cheaper model in dev and a stronger one in production.
 */
export default defineAgent({
  model: process.env.EVE_MODEL ?? "anthropic/claude-opus-4.8",
});
