import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// paseo-plugin-ask: a general "questions" widget for Paseo agents.
//
// Flow: a pi extension (ask-user, ~/.pi/agent/extensions/ask-user/) exposes an
// ask_user tool to the model. The tool writes the question into
// ~/.pi/agent/ask-spool/<agentId>.json. This plugin's server watcher picks it
// up and appends a timeline row; the human answers by tapping an option or
// typing in Other; the answer RPC writes it back into the same spool file;
// the extension's pending tool call returns the answer to the model.
//
// A question can also end without a human answer: superseded by a newer
// question (ask.test, or a fresh ask from a respawned process), timed out,
// cancelled, or expired by the watcher. All write terminal markers into
// answer.other, which the extension translates for the model. The newest
// question for an agent always wins; no state blocks forever.

export const askOptionSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  // When true the row renders this option with the success-green token so the
  // human sees the agent's recommendation at a glance. It never preselects or
  // auto-answers.
  recommended: z.boolean().optional(),
});

export const askAnswerSchema = z.object({
  choice: z.array(z.string()),
  other: z.string().optional(),
  // Option key designated as the lead/foreground choice (multi + leadPick).
  lead: z.string().optional(),
  answeredAt: z.number(),
});

export const askQuestionDataSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  question: z.string(),
  options: z.array(askOptionSchema).min(1),
  // single = immediate buttons (a lone choice axis never defers commit);
  // multi = checkbox array + Submit. Anything not immediate gets exactly
  // one submit button carrying the whole answer including Other text.
  mode: z.enum(["single", "multi"]),
  // With mode multi: every option also gets a single star toggle marking the
  // lead/foreground choice. Starring implies inclusion.
  leadPick: z.boolean().optional(),
  createdAt: z.number(),
  answered: z.boolean(),
  answer: askAnswerSchema.optional(),
});
export type AskQuestionData = z.infer<typeof askQuestionDataSchema>;

export const askSpoolFileSchema = z.object({
  v: z.literal(1),
  question: askQuestionDataSchema,
});
export type AskSpoolFile = z.infer<typeof askSpoolFileSchema>;

export const askAnswerRpc = defineRpc({
  name: "ask.answer",
  input: z.object({
    agentId: z.string(),
    questionId: z.string(),
    choice: z.array(z.string()),
    other: z.string().optional(),
    lead: z.string().optional(),
  }),
  output: z.object({ ok: z.boolean() }),
});

// Spike/demo entry: synthesizes a question row for testing without the pi
// extension. /ask-test in the composer (agent context).
export const askTestRpc = defineRpc({
  name: "ask.test",
  input: z.object({
    agentId: z.string(),
    // "single" (default) | "multi" | "lead" (multi + star)
    mode: z.enum(["single", "multi", "lead"]).optional(),
  }),
  output: z.object({ ok: z.boolean(), questionId: z.string() }),
});
