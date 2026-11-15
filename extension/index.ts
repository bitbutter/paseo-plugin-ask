// pi extension: ask_user tool (Paseo questions widget, client side).
//
// Registers an ask_user tool in every Paseo-spawned pi session. The tool
// writes a question record to ~/.pi/agent/ask-spool/<agentId>.json and waits;
// the paseo-plugin-ask daemon plugin renders it as a tappable timeline row
// (options + Other, optional multi-select), and the answer comes back
// through the same file. Outside Paseo the tool is not registered at all.
//
// Lifecycle: every question ends in exactly one terminal state: answered
// (human), superseded (a newer question won; marker in answer.other), timed
// out, or cancelled. The poller never outlives its own deadline and never
// hangs on a replaced spool file.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";

const SPOOL_DIR = join(homedir(), ".pi", "agent", "ask-spool");
const POLL_MS = 1000;
const DEFAULT_TIMEOUT_SEC = 24 * 60 * 60;
// Terminal markers written into answer.other. SUPERSEDED_MARKER matches the
// constant in paseo-plugin-ask/server/ask.ts (no imports across the two).
const SUPERSEDED_MARKER = "(superseded by a newer question)";
const OVERTAKEN_MARKER = "(user typed a message instead of answering)";
const CANCELLED_MARKER = "(cancelled before an answer)";

interface NormalizedOption {
  key: string;
  label: string;
  recommended?: boolean;
}

interface SpoolAnswer {
  choice: string[];
  other?: string;
  lead?: string;
  answeredAt: number;
}

interface SpoolFile {
  v: 1;
  question: {
    id: string;
    agentId: string;
    question: string;
    options: NormalizedOption[];
    mode: "single" | "multi";
    leadPick?: boolean;
    createdAt: number;
    answered: boolean;
    answer?: SpoolAnswer;
  };
}

function spoolPath(agentId: string): string {
  return join(SPOOL_DIR, `${agentId}.json`);
}

function readSpool(agentId: string): SpoolFile | null {
  try {
    return JSON.parse(readFileSync(spoolPath(agentId), "utf8")) as SpoolFile;
  } catch {
    return null;
  }
}

function writeSpool(agentId: string, file: SpoolFile): void {
  mkdirSync(SPOOL_DIR, { recursive: true });
  const path = spoolPath(agentId);
  // Pid-unique tmp name: the daemon plugin writes the same spool file and a
  // shared tmp path races (renameSync ENOENT) or corrupts the write (roast r7).
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(file));
  renameSync(tmp, path);
}

// Close the question with a terminal marker, but only if the file still
// holds exactly this question and it is still open (never clobber a newer
// question or an existing answer). Returns true when the write happened.
function closeIfStillOpen(agentId: string, question: SpoolFile["question"], marker: string): boolean {
  const current = readSpool(agentId);
  if (current && current.question.id === question.id && !current.question.answered) {
    writeSpool(agentId, {
      v: 1,
      question: {
        ...current.question,
        answered: true,
        answer: { choice: [], other: marker, answeredAt: Date.now() },
      },
    });
    return true;
  }
  return false;
}

function normalizeOptions(raw: unknown): NormalizedOption[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("options must be a non-empty array");
  }
  return raw.map((o, i) => {
    if (typeof o === "string") {
      if (o.trim().length === 0) throw new Error("option labels must be non-empty");
      return { key: `opt${i + 1}`, label: o.trim() };
    }
    if (o && typeof o === "object" && typeof (o as any).label === "string") {
      const obj = o as { label: string; recommended?: boolean };
      if (obj.label.trim().length === 0) throw new Error("option labels must be non-empty");
      return {
        key: `opt${i + 1}`,
        label: obj.label.trim(),
        recommended: obj.recommended === true ? true : undefined,
      };
    }
    throw new Error("each option must be a string or {label, recommended?}");
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export default function (pi: ExtensionAPI) {
  const agentId = process.env.PASEO_AGENT_ID;
  if (!agentId) {
    return; // plain TUI/headless pi: no widget, no tool
  }

  // Question ids this extension instance is currently polling. A question
  // owned by a dead process gets superseded; one owned by THIS process gets
  // a refusal (anti-stacking).
  const liveAsks = new Set<string>();

  // Live view of the session's pending-message queue, captured from any
  // event context. A composer message sent while the turn is blocked steers
  // into pi and sits in this queue until the turn's tool calls finish; the
  // ask_user poll checks it so typing overtakes the question immediately.
  let hasPendingMessages: (() => boolean) | null = null;
  const captureCtx = (ctx: { hasPendingMessages: () => boolean }) => {
    hasPendingMessages = () => ctx.hasPendingMessages();
  };
  pi.on("session_start", (_event, ctx) => captureCtx(ctx));

  // Backstop at steer-delivery time (turn boundary): if a question is still
  // open when the steered text is finally delivered, close it as overtaken.
  pi.on("input", async (event, ctx) => {
    captureCtx(ctx);
    if (event.source === "extension") return;
    try {
      const open = readSpool(agentId);
      if (open && !open.question.answered) {
        closeIfStillOpen(agentId, open.question, OVERTAKEN_MARKER);
      }
    } catch {
      // A fire-and-forget handler must never take the process down (roast r7).
    }
  });

  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description:
      "Ask the human a question with clickable answer options, rendered as a tappable card in the Paseo timeline (desktop and mobile). The tool call blocks until the human answers or the timeout passes, then returns their choice. Default = immediate single-choice buttons (a lone choice axis never defers commit; do not ask for one when immediate buttons fit). multi:true = checkbox array with a Submit button (mark all that apply). multi:true plus lead:true = each option also gets a star to foreground one choice. Options may carry recommended:true to show your recommendation in green. An Other free-text field is always available.",
    promptSnippet: "Ask the user a question with tappable options when a small decision genuinely belongs to them",
    promptGuidelines: [
      "Use ask_user when a decision genuinely belongs to the human, the realistic answers are enumerable (2-6 options), and acting on your own judgment would risk real rework: which direction to take, which of their priorities wins, confirming a tradeoff, or picking items from a list you surfaced (multi:true).",
      "Do not use ask_user for anything you can decide yourself with available context, for approval of commands or edits (permission prompts already exist for that), or habitually mid-task; overusing it just moves your work onto the user.",
      "Keep the question to one short sentence; each option under about 8 words. If you have a recommendation, pass {label, recommended:true} for that one option and say why in your text before calling.",
      "After the tool returns, act on the answer without re-asking. If it times out, proceed with your best judgment and say you did.",
    ],
    parameters: Type.Object({
      question: Type.String({ description: "One short sentence shown to the human." }),
      options: Type.Array(
        Type.Union([
          Type.String(),
          Type.Object({
            label: Type.String(),
            recommended: Type.Optional(Type.Boolean({ description: "Show this option as the agent's recommendation (green)." })),
          }),
        ]),
        { minItems: 1, description: "Answer options: plain strings, or {label, recommended:true} for the one you recommend." },
      ),
      multi: Type.Optional(Type.Boolean({ description: "true = checkbox array, mark all that apply, then Submit." })),
      lead: Type.Optional(Type.Boolean({ description: "with multi:true: add a star to each option to mark one as the lead/foreground choice." })),
      timeout_sec: Type.Optional(Type.Number({ description: "Max seconds to wait. Default 86400 (24h)." })),
    }),
    async execute(_toolCallId, params, signal) {
      let options: NormalizedOption[];
      try {
        options = normalizeOptions(params.options);
      } catch (e: any) {
        return { content: [{ type: "text", text: `ask_user: ${e.message}` }], isError: true };
      }

      const open = readSpool(agentId);
      if (open && !open.question.answered) {
        if (liveAsks.has(open.question.id)) {
          return {
            content: [
              {
                type: "text",
                text: `ask_user: another question from this session is still waiting ("${open.question.question}"). Wait for it to be answered (retry this tool after a pause) instead of stacking questions.`,
              },
            ],
            isError: true,
          };
        }
        // Nobody in this process is polling it: the file was left open by a
        // dead process or a test spike. Supersede it (a foreign live poller
        // sees the marker and returns promptly) instead of blocking forever.
        // closeIfStillOpen re-reads and re-checks so a human answer that
        // landed between our read and this write is never clobbered. The old
        // card may linger looking open until tapped; that beats a sleep-based
        // flip, which reopened a seconds-wide lost-update window (roast r3).
        closeIfStillOpen(agentId, open.question, SUPERSEDED_MARKER);
      }

      const leadPick = params.lead === true;
      const mode: "single" | "multi" = params.multi === true || leadPick ? "multi" : "single";
      const id = `ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const timeoutMs = Math.max(60, Math.min(params.timeout_sec ?? DEFAULT_TIMEOUT_SEC, 7 * 24 * 60 * 60)) * 1000;
      const file: SpoolFile = {
        v: 1,
        question: {
          id,
          agentId,
          question: params.question,
          options,
          mode,
          leadPick: mode === "multi" && leadPick ? true : undefined,
          createdAt: Date.now(),
          answered: false,
        },
      };
      liveAsks.add(id);
      try {
        try {
          writeSpool(agentId, file);
        } catch (e: any) {
          return { content: [{ type: "text", text: `ask_user: spool write failed: ${e?.message ?? String(e)}` }], isError: true };
        }

        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          if (signal.aborted) {
            closeIfStillOpen(agentId, file.question, CANCELLED_MARKER);
            return { content: [{ type: "text", text: "ask_user: cancelled before the user answered." }], isError: true };
          }
          // The user typed in the composer instead of tapping the card: the
          // message steers into pi and queues behind this tool call. Close the
          // question as overtaken; the poll below reads the marker and returns,
          // and the steered text delivers to the model right after this call.
          if (hasPendingMessages && hasPendingMessages()) {
            closeIfStillOpen(agentId, file.question, OVERTAKEN_MARKER);
          }
          const current = readSpool(agentId);
          if (current && current.question.id === id && current.question.answered && current.question.answer) {
            const a = current.question.answer;
            if (a.other === SUPERSEDED_MARKER) {
              return {
                content: [
                  {
                    type: "text",
                    text: `ask_user: the question "${params.question}" was superseded by a newer question before the user answered. Proceed with your best judgment and tell the user what you chose.`,
                  },
                ],
              };
            }
            if (a.other === OVERTAKEN_MARKER) {
              return {
                content: [
                  {
                    type: "text",
                    text: `ask_user: the user typed a new message instead of answering the question "${params.question}". Their message follows; act on it rather than re-asking.`,
                  },
                ],
              };
            }
            const chosen = a.choice.map((k) => options.find((o) => o.key === k)?.label ?? k);
            const parts: string[] = [];
            if (a.lead) parts.push(`lead: ${options.find((o) => o.key === a.lead)?.label ?? a.lead}`);
            if (chosen.length > 0) parts.push(`chosen: ${chosen.join("; ")}`);
            if (a.other) parts.push(`other: ${a.other}`);
            const text =
              parts.length > 0
                ? `The user answered the question "${params.question}".\n${parts.join("\n")}`
                : `The user answered the question "${params.question}" without picking an option or writing text.`;
            return { content: [{ type: "text", text }] };
          }
          // Replaced or removed while we were waiting (a newer question or a
          // test spike overwrote the spool, or the file was cleared by
          // hand): resolve now instead of hanging until the timeout.
          if (!current || current.question.id !== id) {
            return {
              content: [
                {
                  type: "text",
                  text: `ask_user: the question "${params.question}" was replaced or cleared before the user answered. Proceed with your best judgment and tell the user what you chose.`,
                },
              ],
            };
          }
          await sleep(POLL_MS);
        }

        // Timed out: close the question so the next one is not blocked, and
        // leave an honest trace in the row. Guarded re-read: an answer or a
        // newer question that landed during the final poll sleep must never
        // be clobbered; if the question was actually answered, return that.
        if (!closeIfStillOpen(agentId, file.question, "(timed out with no answer)")) {
          const last = readSpool(agentId);
          if (last && last.question.id === id && last.question.answered && last.question.answer) {
            const a = last.question.answer;
            if (a.other === SUPERSEDED_MARKER || a.other === OVERTAKEN_MARKER) {
              return {
                content: [
                  {
                    type: "text",
                    text: `ask_user: the question "${params.question}" ended without a human answer just before the timeout (${a.other}). Proceed with your best judgment and tell the user what you chose.`,
                  },
                ],
              };
            }
            const chosen = a.choice.map((k) => options.find((o) => o.key === k)?.label ?? k);
            const parts: string[] = [];
            if (a.lead) parts.push(`lead: ${options.find((o) => o.key === a.lead)?.label ?? a.lead}`);
            if (chosen.length > 0) parts.push(`chosen: ${chosen.join("; ")}`);
            if (a.other) parts.push(`other: ${a.other}`);
            const text =
              parts.length > 0
                ? `The user answered the question "${params.question}" just before the timeout.\n${parts.join("\n")}`
                : `The user answered the question "${params.question}" without picking an option or writing text.`;
            return { content: [{ type: "text", text }] };
          }
        }
        return {
          content: [
            {
              type: "text",
              text: `ask_user: no answer within ${Math.round(timeoutMs / 1000)}s. Proceed with your best judgment and tell the user what you chose.`,
            },
          ],
        };
      } finally {
        liveAsks.delete(id);
      }
    },
  });
}
