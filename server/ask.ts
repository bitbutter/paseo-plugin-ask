import type { PaseoApi } from "@getpaseo/client";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { askAnswerRpc, askTestRpc, askSpoolFileSchema, type AskQuestionData, type AskSpoolFile } from "../shared/ask";

// The pi extension (ask-user) writes one JSON file per agent here; the answer
// RPC writes the answer back into the same file; the extension's pending
// tool call polls it. Same file-bus pattern as cogdebt-spool.
const SPOOL_DIR = join(homedir(), ".pi", "agent", "ask-spool");
const POLL_MS = 1500;
const ANSWERED_TTL_MS = 24 * 60 * 60 * 1000;
// A live ask_user poller always terminates before this (the extension clamps
// its timeout to 7 days and writes its own terminal state), so an unanswered
// question older than this has no poller left: expire it.
const OPEN_EXPIRE_MS = 8 * 24 * 60 * 60 * 1000;
// An open card is re-appended at this cadence (and immediately on the
// agent's next session_open/turn_started): timeline refetches can drop
// plugin rows client-side, and a lost card must become visible again.
const REAPPEND_MS = 5 * 60 * 1000;
// A failed append is retried at most this often. "Unknown agent" failures
// are not retried at all until that agent fires a session/turn event again.
const FAILED_RETRY_MS = 60 * 1000;
// Terminal markers written into answer.other. The extension recognizes
// SUPERSEDED_MARKER (same literal in ask-user/index.ts) and phrases it for
// the model instead of "the user answered".
const SUPERSEDED_MARKER = "(superseded by a newer question)";
const OVERTAKEN_MARKER = "(user typed a message instead of answering)";
const EXPIRED_MARKER = "(expired with no answer; the asking process is gone)";

// One row per question, identified per-question: `pluginId/rowId` is the
// timeline identity, and the Paseo projection merges same-identity rows AT
// THE ORIGINAL POSITION (seqStart is kept), so a stable per-agent id would
// render every later question far up the timeline where nobody looks
// (found the hard way 2026-11-15: cards "never opened", they updated a row
// 60 entries up). A per-question id makes each new question a fresh row at
// the bottom; an answer update re-appends the same id and flips it in place.
const rowId = (question: { agentId: string; id: string }) => `ask-question-${question.agentId}-${question.id}`;

function spoolPath(agentId: string): string {
  return join(SPOOL_DIR, `${agentId}.json`);
}

function readSpool(agentId: string): AskSpoolFile | null {
  try {
    return askSpoolFileSchema.parse(JSON.parse(readFileSync(spoolPath(agentId), "utf8")));
  } catch {
    return null;
  }
}

function writeSpool(agentId: string, file: AskSpoolFile): void {
  mkdirSync(SPOOL_DIR, { recursive: true });
  const path = spoolPath(agentId);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(file));
  renameSync(tmp, path);
}

async function appendRow(paseo: PaseoApi, question: AskQuestionData): Promise<void> {
  await paseo.agents.ref(question.agentId).timeline.append({
    type: "plugin",
    id: rowId(question),
    kind: "ask-question",
    version: 1,
    data: { ...question },
  });
}

// Close an open question with a terminal marker (no human answer). Re-reads
// and re-checks so it never clobbers a newer question or a human answer that
// landed between the caller's read and this write; returns null when skipped.
function closeQuestion(agentId: string, question: AskQuestionData, marker: string): AskQuestionData | null {
  const current = readSpool(agentId);
  if (!current || current.question.id !== question.id || current.question.answered) {
    return null;
  }
  const closed: AskQuestionData = {
    ...current.question,
    answered: true,
    answer: { choice: [], other: marker, answeredAt: Date.now() },
  };
  writeSpool(agentId, { v: 1, question: closed });
  return closed;
}

export function registerAskHandlers(server: PluginServerContext): void {
  server.handle(askAnswerRpc, async (input, ctx: PluginHandlerContext) => {
    const file = readSpool(input.agentId);
    if (!file || file.question.id !== input.questionId) {
      throw new Error(`no open question ${input.questionId} for agent ${input.agentId}`);
    }
    if (file.question.answered) {
      const other = file.question.answer?.other ?? "";
      const terminal =
        other === SUPERSEDED_MARKER ||
        other === OVERTAKEN_MARKER ||
        other === EXPIRED_MARKER ||
        other.startsWith("(timed out") ||
        other.startsWith("(cancelled");
      if (terminal) {
        // The recorded "answer" is a terminal marker, not a human choice.
        // ok:true here made the client render a phantom confirmation for a
        // tap that was discarded (roast r6).
        throw new Error(`question ${input.questionId} already ended: ${other}`);
      }
      return { ok: true }; // idempotent: an already-answered row just re-affirms
    }
    const answered: AskQuestionData = {
      ...file.question,
      answered: true,
      answer: { choice: input.choice, other: input.other, lead: input.lead, answeredAt: Date.now() },
    };
    writeSpool(input.agentId, { v: 1, question: answered });
    try {
      await appendRow(ctx.paseo, answered); // re-render the row in answered state
    } catch (e) {
      console.error("[ask] answer row re-append failed:", e);
    }
    return { ok: true };
  });

  server.handle(askTestRpc, async (input, ctx: PluginHandlerContext) => {
    const agentId = input.agentId;
    const existing = readSpool(agentId);
    if (existing && !existing.question.answered) {
      // Supersede instead of refusing: an open question whose card was lost
      // (daemon restart or timeline refetch drops plugin rows) must never
      // block new questions. Flip the old row to its closed state so it does
      // not linger as a clickable card. closeQuestion re-validates; if it
      // raced against a newer writer, that writer wins and we skip.
      const closed = closeQuestion(agentId, existing.question, SUPERSEDED_MARKER);
      if (closed) {
        try {
          await appendRow(ctx.paseo, closed);
        } catch {
          /* agent may be gone; cosmetic only */
        }
      }
    }
    const mode = input.mode ?? "single";
    const question: AskQuestionData = {
      id: `test-${Date.now().toString(36)}`,
      agentId,
      mode: mode === "lead" ? "multi" : mode,
      leadPick: mode === "lead" ? true : undefined,
      question:
        mode === "lead"
          ? "ask spike (multi + lead): mark the bullets to include and star the one to foreground"
          : mode === "multi"
            ? "ask spike (multi): mark the options that apply, add a note in Other, then Submit"
            : "ask spike: pick an option or write in Other. The green option is the agent's recommendation.",
      options:
        mode === "lead"
          ? [
              { key: "a", label: "Loop is 90-second heists, rewind, heist again" },
              { key: "b", label: "The player arrests their own future self" },
              { key: "c", label: "Physics puzzles where the evidence is the lie" },
            ]
          : mode === "multi"
            ? [
                { key: "a", label: "First candidate bullet" },
                { key: "b", label: "Second candidate bullet" },
                { key: "c", label: "Third candidate bullet" },
              ]
            : [
                { key: "ship", label: "Ship it as-is", recommended: true },
                { key: "revise", label: "One more revision round" },
                { key: "drop", label: "Start over from another focus" },
              ],
      createdAt: Date.now(),
      answered: false,
    };
    // The awaited appendRow above yielded the event loop: a live ask_user
    // in the extension process may have claimed the spool since our read.
    // Never clobber it; the newest question always wins (roast r6).
    const latest = readSpool(agentId);
    if (existing && latest && latest.question.id !== existing.question.id) {
      throw new Error(`ask.test: a newer question (${latest.question.id}) is live; not overwriting it`);
    }
    writeSpool(agentId, { v: 1, question });
    await appendRow(ctx.paseo, question);
    return { ok: true, questionId: question.id };
  });
}

// Watches the spool for questions written by the pi extension and keeps a
// visible row for each unanswered one. Plugin rows survive plugin reloads
// but not daemon restarts, and client-side timeline refetches can drop
// them, so open questions are re-appended on the agent's session/turn
// events and at a REAPPEND_MS cadence. Unanswered questions older than
// OPEN_EXPIRE_MS are closed as expired; answered files are deleted after
// ANSWERED_TTL_MS. Terminal markers live in answer.other (see
// closeQuestion); the newest question for an agent always wins.
// Limitation: the watcher only sees PaseoApi after some agent fires a
// session/turn event, so right after a plugin reload or daemon start it
// stays idle until the first agent activity (same pattern as cogdebt).
export function startAskWatcher(server: PluginServerContext): () => void {
  console.log("[ask] watcher started");
  let paseo: PaseoApi | null = null;
  const capture = (context: { paseo: PaseoApi }) => {
    paseo ??= context.paseo;
  };
  // agentId -> { id, at } of the last successful row append
  const appended = new Map<string, { id: string; at: number }>();
  // Question ids whose OPEN row this watcher run appended. The closed-card
  // flip only applies to these: rows from before a daemon restart are gone
  // from the timeline, and re-appending them would CREATE a stale card at
  // the bottom instead of replacing one (identity absent = insert).
  const openAppendedIds = new Set<string>();
  // agentId -> question id whose CLOSED state has been appended once, so
  // file-only terminal writes (extension timeout/cancel/supersede) still
  // flip their card instead of lingering as open and tappable
  const closedAppended = new Map<string, string>();

  // Close an open question as overtaken (guarded, best-effort row flip).
  const overtakeIfOpen = async (paseo: PaseoApi | null, agentId: string | null | undefined) => {
    if (!paseo || !agentId) return;
    const file = readSpool(agentId);
    if (!file || file.question.answered) return;
    const closed = closeQuestion(agentId, file.question, OVERTAKEN_MARKER);
    if (!closed) return;
    console.log(`[ask] question ${closed.id} for ${agentId} overtaken (new turn/message)`);
    try {
      await appendRow(paseo, closed);
      closedAppended.set(agentId, closed.id);
    } catch {
      /* cosmetic; the file is terminal either way */
    }
  };
  // agentId -> { id, at } of the last failed append
  const failed = new Map<string, { id: string; at: number }>();
  // Agents whose timeline.append said "Unknown agent": skip their spool
  // files until they fire a session/turn event again (no retry spam).
  const deadAgents = new Set<string>();

  // The agent just became active: re-arm its append state so the next tick
  // re-appends any still-open question (self-heal for cards lost to a
  // timeline refetch) and clears any append failure.
  const rearmAgent = (agentId: string | null | undefined) => {
    if (!agentId) return;
    appended.delete(agentId);
    failed.delete(agentId);
    deadAgents.delete(agentId);
  };
  server.before("agent.session_open", (request, context) => {
    capture(context);
    rearmAgent(request?.request?.agentId);
    // An interactive session_open (agent respawn) while a question is open
    // means the asking process died: close it as overtaken. purpose "history"
    // is just a client viewing the timeline; it must not close anything.
    const req = request?.request;
    if (req && req.purpose !== "history") {
      void overtakeIfOpen(context.paseo, req.agentId);
    }
    return undefined;
  });
  server.on("agent.turn_started", (event, context) => {
    capture(context);
    rearmAgent(event?.agent?.id);
    // A new turn starting while a question is still open means the question
    // belongs to an earlier turn and the human kept typing instead of
    // answering the card: close it as overtaken so any surviving poller
    // returns promptly and the model reacts to the message instead.
    void overtakeIfOpen(context.paseo, event?.agent?.id);
  });
  server.on("agent.turn_ended", (_event, context) => capture(context));

  const tick = async (): Promise<void> => {
    if (!paseo) return;
    let names: string[];
    try {
      names = readdirSync(SPOOL_DIR);
    } catch {
      return; // no spool yet: nothing asked
    }
    const now = Date.now();
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const agentId = name.slice(0, -".json".length);
      let file: AskSpoolFile;
      try {
        file = askSpoolFileSchema.parse(JSON.parse(readFileSync(join(SPOOL_DIR, name), "utf8")));
      } catch {
        continue; // foreign or corrupt file: not ours
      }
      const q = file.question;
      if (q.answered) {
        if (now - (q.answer?.answeredAt ?? q.createdAt) > ANSWERED_TTL_MS) {
          try {
            unlinkSync(join(SPOOL_DIR, name));
          } catch {
            /* raced away */
          }
          closedAppended.delete(agentId);
          openAppendedIds.delete(q.id);
        }
        // Terminal states written file-only by the extension (timeout,
        // cancel, stale-supersede) have no Paseo API to append their own row;
        // flip the card here, once per question id, and only for rows this
        // watcher run opened (after a daemon restart the row is gone and a
        // re-append would insert a stale card). Record the guard only after
        // a successful append; retry at FAILED_RETRY_MS cadence on failure.
        if (
          openAppendedIds.has(q.id) &&
          closedAppended.get(agentId) !== q.id &&
          !(failed.get(agentId)?.id === q.id && now - (failed.get(agentId)?.at ?? 0) < FAILED_RETRY_MS)
        ) {
          try {
            await appendRow(paseo, q);
            closedAppended.set(agentId, q.id);
            failed.delete(agentId);
          } catch (e) {
            failed.set(agentId, { id: q.id, at: now });
            console.error(`[ask] closed-card flip failed for ${agentId}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        appended.delete(agentId);
        continue;
      }
      // No poller can still be waiting (its own timeout would have closed
      // the question earlier): expire it so the row and the agent's next
      // real ask are not blocked forever. This runs BEFORE the deadAgents
      // skip: the write is local and the append failure is tolerated, so an
      // unknown agent must not strand its question open forever.
      if (now - q.createdAt > OPEN_EXPIRE_MS) {
        const closed = closeQuestion(agentId, q, EXPIRED_MARKER);
        // Gate on openAppendedIds: after a daemon restart the row is gone and
        // an unconditional append would CREATE a stale "(expired)" card at
        // the bottom for an 8-day-old question (roast r6 confirmed; same
        // reasoning as the flip gate above).
        if (closed && openAppendedIds.has(q.id)) {
          try {
            await appendRow(paseo, closed); // re-render the row as closed; agent may be gone
          } catch {
            /* cosmetic only */
          }
        }
        continue;
      }
      if (deadAgents.has(agentId)) continue;
      const last = appended.get(agentId);
      if (last && last.id === q.id && now - last.at < REAPPEND_MS) continue;
      const failure = failed.get(agentId);
      if (failure && failure.id === q.id && now - failure.at < FAILED_RETRY_MS) continue;
      try {
        await appendRow(paseo, q);
        appended.set(agentId, { id: q.id, at: now });
        openAppendedIds.add(q.id);
        failed.delete(agentId);
        console.log(`[ask] appended question ${q.id} for ${agentId}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        failed.set(agentId, { id: q.id, at: now });
        if (/Unknown agent/i.test(msg)) {
          deadAgents.add(agentId);
          console.error(`[ask] agent ${agentId} unknown; not retrying question ${q.id} until the agent opens a session`);
        } else {
          console.error(`[ask] append failed for ${agentId}: ${msg}`);
        }
      }
    }
  };
  const timer = setInterval(() => void tick(), POLL_MS);
  void tick();
  return () => clearInterval(timer);
}
