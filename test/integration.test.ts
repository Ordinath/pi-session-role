import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  JsonAgentSessionEvent, RpcCommand, RpcExtensionUIRequest, RpcResponse, SessionEntry,
} from '@earendil-works/pi-coding-agent';
import { ROLE_LABEL } from '../pi/role.ts';

type RecordLine = RpcResponse | RpcExtensionUIRequest | JsonAgentSessionEvent;
type Payload = { messages: { role: string; content: unknown }[] };
const project = fileURLToPath(new URL('..', import.meta.url));

function startPi(env: NodeJS.ProcessEnv, sessionArgs: string[]) {
  const child = spawn('pi', [
    '--mode', 'rpc', '--no-extensions', '--no-skills', '--no-prompt-templates',
    '--no-themes', '--no-context-files', '--no-tools', '--no-mcp',
    '-e', './pi/index.ts', '-e', './test/fixtures/offline.ts',
    '--provider', 'role-test', '--model', 'offline', '--thinking', 'off', ...sessionArgs,
  ], { cwd: project, env, stdio: 'pipe' });
  const records: RecordLine[] = [];
  const events = new EventEmitter();
  let buffer = '';
  let stderr = '';
  let failure: Error | undefined;
  let exited = false;
  let sequence = 0;
  const closed = new Promise<number | null>(resolve => {
    child.on('close', code => {
      exited = true;
      events.emit('change');
      resolve(code);
    });
  });
  child.on('error', error => { failure = error; events.emit('change'); });
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      try { records.push(JSON.parse(line)); }
      catch { failure = new Error(`Non-JSON RPC output: ${line}`); }
    }
    events.emit('change');
  });

  function waitFor(predicate: (record: RecordLine) => boolean, from = 0): Promise<RecordLine> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`RPC timed out. stderr: ${stderr}`)), 20000);
      function finish(error?: Error, record?: RecordLine) {
        clearTimeout(timer);
        events.off('change', check);
        if (error) reject(error);
        else if (record) resolve(record);
      }
      function check() {
        const record = records.slice(from).find(predicate);
        if (record) finish(undefined, record);
        else if (failure || exited) finish(failure ?? new Error(`Pi exited early. stderr: ${stderr}`));
      }
      events.on('change', check);
      check();
    });
  }

  return {
    records,
    async request(command: RpcCommand) {
      const id = `test-${++sequence}`;
      const response = waitFor(record => record.type === 'response' && record.id === id);
      child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
      const record = await response;
      assert.equal(record.type, 'response');
      if (record.type !== 'response') throw new Error('Expected an RPC response');
      assert.equal(record.success, true, JSON.stringify(record));
      return record;
    },
    async run(message: string) {
      const from = records.length;
      await this.request({ type: 'prompt', message });
      await waitFor(record => record.type === 'agent_settled', from);
    },
    notifications(from = 0) {
      return records.slice(from).flatMap(record =>
        record.type === 'extension_ui_request' && record.method === 'notify' ? [record.message] : []);
    },
    async stop() {
      if (!exited) child.stdin.end();
      const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
      try { assert.equal(await closed, 0, `Pi shutdown failed. stderr: ${stderr}`); }
      finally { clearTimeout(timer); }
    },
  };
}

test('real pi 1.4 RPC: commands, provider sections, resume, compaction, custom runs and forks', {
  timeout: 120000,
}, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-session-role-rpc-'));
  const peers: ReturnType<typeof startPi>[] = [];
  const requests: Payload[] = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = {
      id: 'offline', object: 'chat.completion.chunk', created: 0, model: 'offline',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'Offline reply.' }, finish_reason: null }],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
  t.after(async () => {
    try { await Promise.all(peers.map(peer => peer.stop())); }
    finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  // Do not inherit credentials, Pi settings, proxy variables, or live-session environment.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: join(dir, 'home'),
    PI_CODING_AGENT_DIR: join(dir, 'agent'),
    ROLE_TEST_URL: `http://127.0.0.1:${address.port}/v1`,
    NO_PROXY: '127.0.0.1',
  };
  await mkdir(env.HOME!, { recursive: true });
  await mkdir(env.PI_CODING_AGENT_DIR!, { recursive: true });
  await writeFile(join(env.PI_CODING_AGENT_DIR!, 'settings.json'), JSON.stringify({
    compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false },
  }));
  const version = spawnSync('pi', ['--version'], { env, encoding: 'utf8' });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), '1.4.0');
  const launch = (args: string[], environment = env) => {
    const peer = startPi(environment, args);
    peers.push(peer);
    return peer;
  };
  const run = async (peer: ReturnType<typeof startPi>, message: string) => {
    const before = requests.length;
    await peer.run(message);
    assert.equal(requests.length, before + 1, 'Each run must reach the offline provider exactly once');
  };
  const sessions = join(dir, 'sessions');
  const first = launch(['--session-dir', sessions]);
  const state = await first.request({ type: 'get_state' });
  assert.equal(state.command, 'get_state');
  if (state.command !== 'get_state') throw new Error('Expected session state');
  const { sessionId, sessionFile } = state.data;
  assert.ok(sessionFile);
  const result = await first.request({ type: 'prompt', message: '/role set Be terse.' });
  assert.equal(result.command, 'prompt');
  if (result.command !== 'prompt') throw new Error('Expected prompt response');
  assert.equal(result.data.disposition, 'handled');
  assert.ok(first.notifications().includes('Session role set.'));
  assert.equal(requests.length, 0);
  assert.equal(first.records.some(record => record.type === 'agent_start'), false);
  t.diagnostic('RPC /role set: disposition=handled; zero provider requests and zero agent starts');

  const systemText = () => JSON.stringify(requests.at(-1)?.messages.filter(message =>
    message.role === 'system' || message.role === 'developer'));
  const expectRole = (text: string) => {
    assert.ok(systemText().includes('<session_role>'), systemText());
    assert.ok(systemText().includes(ROLE_LABEL), systemText());
    assert.ok(systemText().includes(text), systemText());
  };
  await run(first, 'First offline run.');
  assert.equal(requests.length, 1);
  expectRole('Be terse.');
  assert.ok(first.notifications().some(message => message.includes('"forced":false')));
  let entries: SessionEntry[] = (await readFile(sessionFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const stored = entries.find(entry => entry.type === 'custom' && entry.customType === 'session-role');
  assert.ok(stored && stored.type === 'custom');
  assert.ok(typeof stored.data === 'object' && stored.data !== null && 'setAt' in stored.data);
  assert.equal(typeof stored.data.setAt, 'string');
  assert.deepEqual(stored.data, { sessionId, text: 'Be terse.', setAt: stored.data.setAt });
  assert.equal(entries.some(entry => entry.type === 'custom_message' && entry.customType === 'session-role'), false);
  assert.equal(JSON.stringify(requests[0]).includes('/role set'), false);
  t.diagnostic('Localhost provider request contains <session_role> and the label; storage is custom, not conversation');
  await first.stop();

  // A different HOME/agent directory models re-hosting; the session file is the only carried state.
  const secondAgent = join(dir, 'second-agent');
  await mkdir(join(dir, 'second-home'));
  await mkdir(secondAgent);
  await writeFile(join(secondAgent, 'settings.json'), JSON.stringify({
    compaction: { enabled: false, keepRecentTokens: 1 }, retry: { enabled: false },
  }));
  const resumed = launch(['--session', sessionFile, '--session-dir', sessions], {
    ...env, HOME: join(dir, 'second-home'), PI_CODING_AGENT_DIR: secondAgent,
  });
  const resumedState = await resumed.request({ type: 'get_state' });
  assert.ok(resumedState.command === 'get_state');
  assert.equal(resumedState.data.sessionId, sessionId);
  await resumed.request({ type: 'prompt', message: '/role show' });
  assert.ok(resumed.notifications().includes(`${ROLE_LABEL}\nBe terse.`));
  await run(resumed, 'After restart.');
  expectRole('Be terse.');
  await run(resumed, '/test-custom-run');
  expectRole('Be terse.');
  assert.ok(resumed.notifications().some(message => message.includes('"testRun":"custom"')));
  await resumed.request({ type: 'compact' });
  await run(resumed, 'After compaction.');
  expectRole('Be terse.');
  entries = (await readFile(sessionFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(entries.some(entry => entry.type === 'compaction'));
  t.diagnostic('Same session ID survives restart with a new HOME/agent directory, custom-message run and real compaction');
  await resumed.stop();

  const relocatedFile = join(dir, 'rehosted-session.jsonl');
  await copyFile(sessionFile, relocatedFile);
  const rehosted = launch(['--session', relocatedFile, '--session-dir', sessions]);
  await run(rehosted, 'After moving the session file.');
  expectRole('Be terse.');
  await rehosted.stop();

  const fork = launch(['--fork', relocatedFile, '--session-dir', sessions]);
  const forkState = await fork.request({ type: 'get_state' });
  assert.ok(forkState.command === 'get_state');
  assert.notEqual(forkState.data.sessionId, sessionId);
  await fork.request({ type: 'prompt', message: '/role show' });
  assert.ok(fork.notifications().some(message => /parent session.*ignored in this fork/.test(message)));
  await run(fork, 'Fork without a role.');
  assert.equal(systemText().includes('session_role'), false, systemText());
  assert.equal(systemText().includes('Be terse.'), false, systemText());
  await fork.request({ type: 'prompt', message: '/role set Fork only.' });
  await run(fork, 'Fork with its own role.');
  expectRole('Fork only.');
  await fork.request({ type: 'prompt', message: '/role clear' });
  await run(fork, 'Fork after clear.');
  assert.equal(systemText().includes('session_role'), false, systemText());
  t.diagnostic('--fork: new ID, ignored-parent notification, no role in provider system prompt; own set/clear work');

  const roleFile = join(env.HOME!, 'role.txt');
  await writeFile(roleFile, 'File snapshot.\n');
  await fork.request({ type: 'prompt', message: '/role set @~/role.txt' });
  await rm(roleFile);
  await run(fork, 'After deleting the role file.');
  expectRole('File snapshot.');
  const requestCount = requests.length;
  for (const message of ['/role set', `/role set ${'é'.repeat(16385)}`, '/role set @missing-role-file']) {
    const from = fork.records.length;
    await fork.request({ type: 'prompt', message });
    assert.ok(fork.notifications(from).some(text => /empty|32 KiB|Cannot read role file/.test(text)));
  }
  assert.equal(requests.length, requestCount);
  await fork.request({ type: 'prompt', message: '/role show' });
  assert.ok(fork.notifications().includes(`${ROLE_LABEL}\nFile snapshot.\n`));
  t.diagnostic('RPC @~/path is a one-time UTF-8 snapshot; empty, oversized and unreadable inputs leave it unchanged');
});
