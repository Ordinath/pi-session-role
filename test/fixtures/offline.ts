import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

// Test-only: the integration test owns this loopback server. No credentials or remote APIs.
export default function offline(pi: ExtensionAPI) {
  const baseUrl = process.env.ROLE_TEST_URL;
  if (!baseUrl || !/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(baseUrl)) {
    throw new Error('The role integration test requires a loopback provider URL.');
  }
  pi.registerProvider('role-test', {
    baseUrl,
    api: 'openai-completions',
    apiKey: 'offline-test-only',
    models: [{
      id: 'offline', name: 'Offline test', reasoning: false, input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000, maxTokens: 1024,
    }],
  });
  pi.on('before_agent_start', (event, ctx) => {
    ctx.ui.notify(JSON.stringify({
      testRun: event.messageType,
      sections: event.systemPromptOptions.sections,
      forced: event.systemPromptOptions.forceSystemPrompt !== undefined,
    }), 'info');
  });
  pi.registerCommand('test-custom-run', {
    handler: async () => {
      pi.sendMessage({ customType: 'test-trigger', content: 'Offline custom run.', display: false }, {
        triggerTurn: true,
      });
    },
  });
  pi.on('session_before_compact', event => ({
    compaction: {
      summary: 'Offline test summary.',
      firstKeptEntryId: event.preparation.firstKeptEntryId,
      tokensBefore: event.preparation.tokensBefore,
    },
  }));
}
