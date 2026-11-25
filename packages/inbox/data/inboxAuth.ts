import { pageServerSession } from '../api';
import { inboxUrl } from '../inboxUrl';

/** One account at the sign-in door, as the card shows it. */
export interface InboxAuthAccount {
  email: string;
  name: string;
  createdAt: string;
  lastSeenAt: string | null;
  /** Whether its address is on the list that may enter. An account off the list cannot ask for a code. */
  allowed: boolean;
}

/** What the door is, answered by `GET /api/inbox/sign-in`. */
export interface InboxAuthView {
  configured: boolean;
  on: boolean;
  host: string;
  port: number;
  url: string | null;
  allow: string[];
  error: string | null;
  minPasswordLength: number;
  accounts: InboxAuthAccount[];
}

export class InboxAuthRefusal extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

async function answer<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => null)) as (T & { error?: string; code?: string }) | null;
  if (!response.ok) throw new InboxAuthRefusal(body?.error ?? `HTTP ${response.status}`, body?.code ?? 'failed');
  return body as T;
}

export async function readInboxAuth(): Promise<InboxAuthView> {
  return answer<InboxAuthView>(await fetch(inboxUrl('/sign-in'), { headers: { Accept: 'application/json' } }));
}

export async function postInboxAuth(
  action: 'on' | 'off' | 'allow' | 'account' | 'account/remove',
  body: Record<string, unknown>,
): Promise<InboxAuthView> {
  const response = await fetch(inboxUrl(`/sign-in/${action}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ ...body, serverSession: pageServerSession() }),
  });
  return answer<InboxAuthView>(response);
}
