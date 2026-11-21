import type { Session } from "@/types";

/**
 * Editing a sent message creates a new version of the conversation (a session with forkOrigin…).
 * A conversation = its top session plus every version forked from it (recursively).
 */
export function conversationRootId(sessionId: string, sessions: Session[]): string {
  let current = sessions.find((session) => session.id === sessionId);
  while (current?.forkOriginSessionId) {
    const origin = sessions.find((session) => session.id === current!.forkOriginSessionId);
    if (!origin) break;
    current = origin;
  }
  return current?.id ?? sessionId;
}

export function conversationMembers(rootSessionId: string, sessions: Session[]): Session[] {
  const members: Session[] = [];
  const collect = (sessionId: string) => {
    const session = sessions.find((candidate) => candidate.id === sessionId);
    if (session) members.push(session);
    for (const fork of sessions.filter((candidate) => candidate.forkOriginSessionId === sessionId)) collect(fork.id);
  };
  collect(rootSessionId);
  return members;
}

/** The version of a conversation that was used last – opened when the conversation is picked in the sidebar. */
export function latestVersionId(rootSessionId: string, sessions: Session[]): string {
  const members = conversationMembers(rootSessionId, sessions);
  return members.reduce((latest, session) => (session.updatedAt > latest.updatedAt ? session : latest), members[0] ?? { id: rootSessionId, updatedAt: 0 }).id;
}

/** Versions of one user message: the original plus every edit of it, oldest first. */
export function messageVersions(session: Session, itemId: string, sessions: Session[]): { versionSessionIds: string[]; currentIndex: number } {
  const isEditedMessage = session.forkItemId === itemId && session.forkOriginSessionId && session.forkOriginItemId;
  const rootSessionId = isEditedMessage ? session.forkOriginSessionId! : session.id;
  const rootItemId = isEditedMessage ? session.forkOriginItemId! : itemId;
  const edits = sessions
    .filter((candidate) => candidate.forkOriginSessionId === rootSessionId && candidate.forkOriginItemId === rootItemId && candidate.forkItemId)
    .sort((first, second) => first.createdAt - second.createdAt);
  const versionSessionIds = [rootSessionId, ...edits.map((edit) => edit.id)];
  return { versionSessionIds, currentIndex: Math.max(0, versionSessionIds.indexOf(session.id)) };
}
