import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { askAnswerRpc, type AskQuestionData } from "../shared/ask";

type Sent = { choice: string[]; other?: string; lead?: string };

// The general questions widget row. Two modes:
// - single: option buttons fire immediately; Other + Send is the free-text
//   immediate action. No submit button needed (every element acts at once).
//   A lone choice axis never defers commit; radio semantics reduce to this.
// - multi: checkbox array (toggle) plus ONE Submit; with leadPick every
//   option also carries a single-star toggle for the lead/foreground choice,
//   and starring implies inclusion.
// Rule: any mode whose elements do not act immediately (multi) has exactly
// one submit button carrying the whole answer.
// Recommended options render with the success-green token; they never
// preselect.
export function QuestionRow({ item, theme, layout }: PluginTimelineItemProps<AskQuestionData>) {
  const d = item.data;
  const answerRpc = useRpc(askAnswerRpc);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [lead, setLead] = useState<string | null>(null);
  const [other, setOther] = useState("");
  const [sent, setSent] = useState<Sent | null>(
    d.answered && d.answer ? { choice: d.answer.choice, other: d.answer.other, lead: d.answer.lead } : null,
  );
  // The Paseo projection updates item.data in place when the row is
  // re-appended (another device answered, or a terminal flip landed). Sync
  // the recorded answer so a mounted open card flips instead of staying
  // tappable and phantom-confirming a discarded tap (roast r6).
  useEffect(() => {
    if (d.answered && d.answer) {
      setSent({ choice: d.answer.choice, other: d.answer.other, lead: d.answer.lead });
    }
  }, [d.answered, d.answer]);
  const [error, setError] = useState<string | null>(null);

  const labelOf = (key: string) => d.options.find((o) => o.key === key)?.label ?? key;

  const send = async (choice: string[], otherText?: string, leadKey?: string | null) => {
    if (busy || sent) return;
    setBusy(true);
    setError(null);
    try {
      await answerRpc({
        agentId: d.agentId,
        questionId: d.id,
        choice,
        other: otherText && otherText.trim().length > 0 ? otherText.trim() : undefined,
        lead: leadKey ?? undefined,
      });
      setSent({ choice, other: otherText, lead: leadKey ?? undefined });
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  // multi: checkbox toggle; unchecking clears that option's star
  const toggle = (key: string) => {
    setPicked((p) => (p.includes(key) ? p.filter((k) => k !== key) : [...p, key]));
    setLead((l) => (l === key ? null : l));
  };

  // multi + leadPick: single star; starring implies inclusion
  const star = (key: string) => {
    const nextLead = lead === key ? null : key;
    setLead(nextLead);
    if (nextLead) {
      setPicked((p) => (p.includes(key) ? p : [...p, key]));
    }
  };

  const submit = () => {
    return void send([...picked], other, lead);
  };

  // Two-column wrap for compact option sets: no lead stars, 4+ options, and
  // every label short enough to survive half-width without wrapping mid-word
  // (tk, 2026-11-15). Long labels and leadPick keep the stacked full-width rows.
  const useGrid =
    !(d.mode === "multi" && d.leadPick) && d.options.length >= 4 && d.options.every((o) => o.label.length <= 22);

  const styles = useMemo(() => {
    const option = (pickedNow: boolean, recommended: boolean) => ({
      paddingVertical: 8,
      paddingHorizontal: 10,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: recommended ? theme.colors.statusSuccess : pickedNow ? theme.colors.accent : theme.colors.border,
      backgroundColor: pickedNow ? theme.colors.accent : theme.colors.surface1,
      opacity: busy ? 0.6 : 1,
    });
    return {
      card: {
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 10,
        padding: layout.compact ? 10 : 12,
        gap: 8,
      },
      question: { color: theme.colors.foreground, fontSize: layout.compact ? 14 : 15, fontWeight: "600" as const },
      hint: { color: theme.colors.foregroundMuted, fontSize: 12 },
      optionRow: { flexDirection: "row" as const, gap: 6, alignItems: "center" as const },
      option,
      grid: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 6 },
      gridOption: (pickedNow: boolean, recommended: boolean) => ({
        ...option(pickedNow, recommended),
        width: "48%" as const,
        alignItems: "center" as const,
      }),
      optionText: (pickedNow: boolean, recommended: boolean) => ({
        color: pickedNow ? theme.colors.accentForeground : recommended ? theme.colors.statusSuccess : theme.colors.foreground,
        fontSize: layout.compact ? 13 : 14,
        fontWeight: recommended ? ("700" as const) : ("400" as const),
      }),
      star: (on: boolean) => ({
        width: 34,
        height: 34,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: on ? theme.colors.accent : theme.colors.border,
        backgroundColor: on ? theme.colors.accent : theme.colors.surface1,
        opacity: busy ? 0.6 : 1,
      }),
      starText: (on: boolean) => ({ color: on ? theme.colors.accentForeground : theme.colors.foregroundMuted, fontSize: 16 }),
      otherRow: { flexDirection: "row" as const, gap: 6, alignItems: "center" as const },
      otherInput: {
        flex: 1,
        color: theme.colors.foreground,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 8,
        paddingVertical: 6,
        paddingHorizontal: 8,
        fontSize: layout.compact ? 13 : 14,
      },
      smallButton: {
        paddingVertical: 7,
        paddingHorizontal: 10,
        borderRadius: 8,
        backgroundColor: theme.colors.accent,
        opacity: busy ? 0.6 : 1,
      },
      smallButtonText: { color: theme.colors.accentForeground, fontSize: 13, fontWeight: "600" as const },
      submitButton: {
        paddingVertical: 9,
        paddingHorizontal: 12,
        borderRadius: 8,
        // Commit actions are green (statusSuccess); checked options use the
        // accent color so the two never read as the same state (tk, 2026-11-15).
        backgroundColor: theme.colors.statusSuccess,
        alignItems: "center" as const,
        opacity: busy ? 0.6 : 1,
      },
      answeredLine: { color: theme.colors.statusSuccess, fontSize: 13, fontWeight: "600" as const },
      error: { color: theme.colors.foregroundMuted, fontSize: 12 },
    };
  }, [theme, layout.compact, busy]);

  if (sent) {
    return (
      <View style={styles.card}>
        <Text style={styles.question}>{d.question}</Text>
        {sent.lead ? <Text style={styles.answeredLine}>★ lead: {labelOf(sent.lead)}</Text> : null}
        {sent.choice
          .filter((k) => k !== sent.lead)
          .map((k) => (
            <Text key={k} style={styles.answeredLine}>
              ✓ {labelOf(k)}
            </Text>
          ))}
        {sent.other ? <Text style={styles.answeredLine}>✎ {sent.other}</Text> : null}
        {!sent.choice.length && !sent.other ? <Text style={styles.answeredLine}>✓ answered (no option chosen)</Text> : null}
      </View>
    );
  }

  const hintText =
    d.mode === "multi"
      ? d.leadPick
        ? "Mark all that apply, star the lead choice, then Submit."
        : "Mark all that apply, then Submit."
      : "Pick one. Or answer in your own words below.";
  const needsSubmit = d.mode === "multi";

  const optionGlyph = (key: string) => (d.mode === "multi" ? (picked.includes(key) ? "☑ " : "☐ ") : "");
  const submitLabel = d.mode === "multi" ? `Submit (${picked.length} marked${d.leadPick && lead ? ", ★ lead" : ""})` : "Submit";

  return (
    <View style={styles.card}>
      <Text style={styles.question}>{d.question}</Text>
      <Text style={styles.hint}>{hintText}</Text>
      {useGrid ? (
        <View style={styles.grid}>
          {d.options.map((o) => {
            const on = d.mode === "multi" ? picked.includes(o.key) : false;
            return (
              <Pressable
                key={o.key}
                accessibilityRole="button"
                accessibilityLabel={o.recommended ? `${o.label} (recommended)` : o.label}
                disabled={busy}
                onPress={() => {
                  if (d.mode === "multi") toggle(o.key);
                  else void send([o.key]);
                }}
                style={styles.gridOption(on, o.recommended === true)}
              >
                <Text style={styles.optionText(on, o.recommended === true)}>
                  {optionGlyph(o.key)}
                  {o.recommended === true ? "★ " : ""}
                  {o.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : (
        d.options.map((o) => {
        const on = d.mode === "multi" ? picked.includes(o.key) : false;
        return (
          <View key={o.key} style={styles.optionRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={o.recommended ? `${o.label} (recommended)` : o.label}
              disabled={busy}
              onPress={() => {
                if (d.mode === "multi") toggle(o.key);
                else void send([o.key]);
              }}
              style={[{ flex: 1 }, styles.option(on, o.recommended === true)]}
            >
              <Text style={styles.optionText(on, o.recommended === true)}>
                {optionGlyph(o.key)}
                {o.recommended === true ? "★ " : ""}
                {o.label}
              </Text>
            </Pressable>
            {d.mode === "multi" && d.leadPick ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={lead === o.key ? `${o.label} is the lead` : `Mark ${o.label} as the lead`}
                disabled={busy}
                onPress={() => star(o.key)}
                style={styles.star(lead === o.key)}
              >
                <Text style={styles.starText(lead === o.key)}>{lead === o.key ? "★" : "☆"}</Text>
              </Pressable>
            ) : null}
          </View>
        );
        })
      )}
      <View style={styles.otherRow}>
        <TextInput
          accessibilityLabel="Other answer"
          placeholder="Other..."
          placeholderTextColor={theme.colors.foregroundMuted}
          value={other}
          onChangeText={setOther}
          style={styles.otherInput}
          editable={!busy}
          returnKeyType={needsSubmit ? "default" : "send"}
          onSubmitEditing={() => (needsSubmit ? undefined : void send([], other))}
        />
        {!needsSubmit ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Send other answer"
            disabled={busy}
            onPress={() => void send([], other)}
            style={styles.smallButton}
          >
            <Text style={styles.smallButtonText}>Send</Text>
          </Pressable>
        ) : null}
      </View>
      {needsSubmit ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Submit answer"
          disabled={busy}
          onPress={submit}
          style={styles.submitButton}
        >
          <Text style={styles.smallButtonText}>{submitLabel}</Text>
        </Pressable>
      ) : null}
      {error ? <Text style={styles.error}>Answer failed: {error}</Text> : null}
    </View>
  );
}
