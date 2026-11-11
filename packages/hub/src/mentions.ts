import type { Member } from './types';

export function parseMentions(body: string, members: Member[], senderId: string | null): string[] {
  return members.filter((m) => m.id !== senderId && body.includes(`@${m.name}`)).map((m) => m.id);
}
