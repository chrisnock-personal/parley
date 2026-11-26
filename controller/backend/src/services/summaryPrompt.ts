// src/services/summaryPrompt.ts
// The prompt and Ollama payload for shift summaries (#42). Kept separate from
// summaryService.ts so the exact text sent to the model can be checked by a
// focused test without a database or a running Ollama.

export interface SummaryLine {
  at: Date;
  name: string | null;
  extension: string;
  kind: 'said' | 'typed';
  text: string;
}

// Lower than the old 0.2: the blur in #42 was renaming an item, not a wrong
// fact, and a near-greedy draw is less likely to substitute a similar name.
export const SUMMARY_TEMPERATURE = 0.1;

export const SYSTEM_PROMPT = `You summarise a broadcast crew's intercom group for the people coming on next.
You get the group's lines in time order: what people said (transcribed speech, which can contain recognition errors) and what they typed.
Write 2 to 4 plain sentences of facts (a few more if needed to fit every typed note): decisions, changes to plans, problems and whether they were solved, and who is doing what.
Keep the exact names of items, places and people as they are written in the lines. Similar names refer to different things: never rename one to another, merge them, or guess which one a line means. Never insert an adjective that wasn't in the line.
Include every typed note. Each typed note in the lines must be represented in the summary with its fact; don't leave one out because it seems minor. Keep a typed note's wording where you can.
Use only what is in the lines. Don't invent names, times or events, don't add advice, and don't start with a preamble like "Here is a summary".`;

/** The same time-ordered, labelled lines the model sees, also used for the
 * "source lines" disclosure in the UI. */
export function formatSummaryLines(lines: SummaryLine[], tz: string): string {
  const time = (d: Date) => new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(d);
  return lines.map((l) => `[${time(l.at)}] ${l.name ?? l.extension} (${l.kind === 'typed' ? 'typed note' : 'said'}): ${l.text}`).join('\n');
}

/** The complete request body, so a test can assert what the model receives. */
export function buildSummaryRequest(groupName: string, lines: SummaryLine[], tz: string, model: string) {
  return {
    model,
    stream: false,
    options: { temperature: SUMMARY_TEMPERATURE },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Group: ${groupName}\n\n${formatSummaryLines(lines, tz)}` },
    ],
  };
}
