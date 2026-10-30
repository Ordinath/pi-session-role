import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { parseRoleArgs, readRoleText, roleOnBranch, ROLE_ENTRY, ROLE_LABEL } from './role.ts';

export default function sessionRole(pi: ExtensionAPI) {
  pi.registerCommand('role', {
    description: 'Set, show, or clear this session’s system-prompt role',
    handler: async (args, ctx) => {
      try {
        const command = parseRoleArgs(args);
        const sessionId = ctx.sessionManager.getSessionId();
        if (command.action === 'show') {
          const role = roleOnBranch(ctx.sessionManager.getBranch(), sessionId);
          ctx.ui.notify(role.text ? `${ROLE_LABEL}\n${role.text}` : role.ignoredParent
            ? 'No active session role. The parent session’s role is ignored in this fork.'
            : 'No active session role.', 'info');
          return;
        }
        const text = command.action === 'set' ? await readRoleText(command.input, ctx.cwd) : '';
        pi.appendEntry(ROLE_ENTRY, { sessionId, text, setAt: new Date().toISOString() });
        ctx.ui.notify(command.action === 'clear' ? 'Session role cleared.' : 'Session role set.', 'info');
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), 'error');
      }
    },
  });

  pi.on('before_agent_start', (event, ctx) => {
    // Re-read for every run, including custom messages, branch switches and compaction.
    const { text } = roleOnBranch(ctx.sessionManager.getBranch(), ctx.sessionManager.getSessionId());
    if (text) event.systemPromptOptions.sections['session_role'] = `${ROLE_LABEL}\n${text}`;
  });
}
