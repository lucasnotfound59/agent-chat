export interface MentionQuery {
  /** Index of the '@'. */
  start: number;
  query: string;
}

/** The `@word` the caret sits at the end of, if any. */
export function mentionQuery(text: string, caret: number): MentionQuery | null {
  const m = /(^|\s)@([^\s@]*)$/.exec(text.slice(0, caret));
  return m ? { start: caret - m[2].length - 1, query: m[2] } : null;
}

export function filterMembers<T extends { name: string }>(members: T[], query: string): T[] {
  const q = query.toLowerCase();
  const hits = members.filter((m) => m.name.toLowerCase().includes(q));
  const starts = hits.filter((m) => m.name.toLowerCase().startsWith(q));
  return [...starts, ...hits.filter((m) => !starts.includes(m))];
}

export function applyMention(text: string, start: number, caret: number, name: string): { text: string; caret: number } {
  const insert = `@${name} `;
  return { text: text.slice(0, start) + insert + text.slice(caret), caret: start + insert.length };
}
