import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export const ROLE_ENTRY = 'session-role';
export const ROLE_LABEL = 'Session role (set by the user for this session):';
export const MAX_ROLE_BYTES = 32 * 1024;
const USAGE = 'Usage: /role set <text> | /role set @<path> | /role show | /role clear';

type RoleCommand = { action: 'set'; input: string } | { action: 'show' | 'clear' };

export function parseRoleArgs(args: string): RoleCommand {
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(args.trimStart());
  const action = match?.[1];
  const input = match?.[2] ?? '';
  if (action === 'set') {
    if (!input.trim()) throw new Error('Role text must not be empty.');
    return { action, input };
  }
  if ((action === 'show' || action === 'clear') && !input.trim()) return { action };
  throw new Error(USAGE);
}

export function validateRoleText(text: string): string {
  if (!text.trim()) throw new Error('Role text must not be empty.');
  if (Buffer.byteLength(text, 'utf8') > MAX_ROLE_BYTES) {
    throw new Error('Role text must be at most 32 KiB (32768 UTF-8 bytes).');
  }
  return text;
}

export function resolveRolePath(path: string, cwd: string): string {
  if (path === '~') return homedir();
  return path.startsWith('~/') ? resolve(homedir(), path.slice(2)) : resolve(cwd, path);
}

export async function readRoleText(input: string, cwd: string): Promise<string> {
  if (!input.startsWith('@')) return validateRoleText(input);
  const path = input.slice(1).trim();
  if (!path) throw new Error('A file path is required after @.');
  let text: string;
  try {
    text = await readFile(resolveRolePath(path, cwd), 'utf8');
  } catch (error) {
    throw new Error(`Cannot read role file "${path}": ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateRoleText(text);
}

export interface RoleData {
  sessionId: string;
  text: string;
  setAt: string;
}

function isRoleData(data: unknown): data is RoleData {
  return typeof data === 'object' && data !== null &&
    'sessionId' in data && typeof data.sessionId === 'string' &&
    'text' in data && typeof data.text === 'string' &&
    'setAt' in data && typeof data.setAt === 'string';
}

// The caller supplies only the current branch, in root-to-leaf order.
export function roleOnBranch(
  branch: readonly { type: string; customType?: string; data?: unknown }[],
  sessionId: string,
): { text: string; ignoredParent: boolean } {
  let own: RoleData | undefined;
  let inherited: RoleData | undefined;
  for (const entry of branch) {
    if (entry.type !== 'custom' || entry.customType !== ROLE_ENTRY || !isRoleData(entry.data)) continue;
    if (entry.data.sessionId === sessionId) own = entry.data;
    else inherited = entry.data;
  }
  return { text: own?.text ?? '', ignoredParent: own === undefined && !!inherited?.text };
}
