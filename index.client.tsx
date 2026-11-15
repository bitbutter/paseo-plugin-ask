import type { PluginClientContext } from "@getpaseo/plugin/client";
import { QuestionRow } from "./client/QuestionRow";
import { askQuestionDataSchema, askTestRpc } from "./shared/ask";

// Renderers first: a rejected registration that throws during entry
// evaluation would take later registrations down with it (cogdebt incident
// 2026-09-19).
export default function contribute(client: PluginClientContext): () => void {
  client.addTimelineRenderer({
    kind: "ask-question",
    version: 1,
    schema: askQuestionDataSchema,
    Component: QuestionRow,
  });

  // /ask-test in the composer (agent context) appends a demo question row:
  // "single" (default), "multi", or "lead" (multi + star). This exercises
  // the whole spike surface: renderer with RPC-firing pressables,
  // checkboxes, the star, and TextInput.
  client.addSlashCommand({
    name: "ask-test",
    description: "Append a demo ask-question row (questions widget test)",
    argumentHint: "[single|multi|lead]",
    context: "agent",
    async onSubmit({ args, agent, rpc }) {
      const raw = args.trim().toLowerCase();
      const mode = raw === "multi" || raw === "lead" ? raw : "single";
      const res = await rpc(askTestRpc, { agentId: agent.id, mode });
      console.log(`[ask] test question ${res.questionId} appended (${mode})`);
    },
  });

  return () => {};
}
