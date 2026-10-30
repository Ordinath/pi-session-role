import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MAX_ROLE_BYTES, parseRoleArgs, readRoleText, resolveRolePath, roleOnBranch, validateRoleText,
} from '../pi/role.ts';

const entry = (text: string, sessionId = 'current', setAt = '2026-01-01T00:00:00.000Z') => ({
  type: 'custom', customType: 'session-role', data: { sessionId, text, setAt },
});

test('parses the three commands, preserving multiline text and paths with spaces', () => {
  assert.deepEqual(parseRoleArgs('set Be terse.'), { action: 'set', input: 'Be terse.' });
  assert.deepEqual(parseRoleArgs('  set  First line\nSecond line. '), {
    action: 'set', input: 'First line\nSecond line. ',
  });
  assert.deepEqual(parseRoleArgs('set @roles/my role.md'), { action: 'set', input: '@roles/my role.md' });
  assert.deepEqual(parseRoleArgs('show  '), { action: 'show' });
  assert.deepEqual(parseRoleArgs('clear'), { action: 'clear' });
  for (const args of ['', 'unknown', 'show extra', 'clear extra', 'setting text']) {
    assert.throws(() => parseRoleArgs(args), /Usage: \/role/);
  }
  for (const args of ['set', 'set  \n ']) assert.throws(() => parseRoleArgs(args), /must not be empty/);
});

test('latest role on the supplied branch wins, not the greatest timestamp or abandoned branch', () => {
  const root = entry('First', 'current', '2026-12-01T00:00:00.000Z');
  const left = [root, entry('Left')];
  const right = [root, entry('Right')];
  assert.deepEqual(roleOnBranch([], 'current'), { text: '', ignoredParent: false });
  assert.equal(roleOnBranch(left, 'current').text, 'Left');
  assert.equal(roleOnBranch(right, 'current').text, 'Right');
  assert.equal(roleOnBranch([root], 'current').text, 'First');
});

test('clear wins and navigating before it restores the role', () => {
  const set = entry('Be terse.');
  assert.deepEqual(roleOnBranch([set, entry('')], 'current'), { text: '', ignoredParent: false });
  assert.equal(roleOnBranch([set], 'current').text, 'Be terse.');
  assert.equal(roleOnBranch([set, entry(''), entry('New role')], 'current').text, 'New role');
});

test('forks ignore other session IDs and can set and clear their own role', () => {
  const parent = entry('Parent role', 'parent');
  assert.deepEqual(roleOnBranch([parent], 'current'), { text: '', ignoredParent: true });
  assert.deepEqual(roleOnBranch([parent, entry('')], 'current'), { text: '', ignoredParent: false });
  assert.deepEqual(roleOnBranch([parent, entry('Child role')], 'current'), {
    text: 'Child role', ignoredParent: false,
  });
  assert.equal(roleOnBranch([entry('Child role'), parent], 'current').text, 'Child role');
  assert.deepEqual(roleOnBranch([parent, entry('', 'parent')], 'current'), { text: '', ignoredParent: false });
});

test('unrelated, malformed and conversation entries do not affect stored state', () => {
  const branch = [entry('Keep'),
    { ...entry('Wrong'), type: 'custom_message' },
    { ...entry('Wrong'), customType: 'other' },
    { type: 'compaction' },
    ...[null, {}, { sessionId: 'current', text: 4, setAt: '' }].map(data => ({
      type: 'custom', customType: 'session-role', data,
    })),
  ];
  assert.equal(roleOnBranch(branch, 'current').text, 'Keep');
});

test('rejects empty roles and enforces 32 KiB in UTF-8 bytes, including the boundary', () => {
  for (const text of ['', ' \n\t ']) assert.throws(() => validateRoleText(text), /must not be empty/);
  assert.equal(validateRoleText('x'.repeat(MAX_ROLE_BYTES)).length, MAX_ROLE_BYTES);
  assert.equal(validateRoleText('é'.repeat(MAX_ROLE_BYTES / 2)).length, MAX_ROLE_BYTES / 2);
  for (const text of ['x'.repeat(MAX_ROLE_BYTES + 1), 'é'.repeat(MAX_ROLE_BYTES / 2) + 'x']) {
    assert.throws(() => validateRoleText(text), /32 KiB.*32768 UTF-8 bytes/);
  }
});

test('@path reads UTF-8 once, preserves contents, resolves cwd and validates files', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-session-role-unit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'role with spaces.md');
  const contents = '  Réponds brièvement.\n';
  await writeFile(path, contents);
  const stored = await readRoleText('@role with spaces.md', dir);
  assert.equal(stored, contents);
  assert.equal(await readRoleText(`@${path}`, '/unused'), contents);
  await writeFile(path, 'changed');
  assert.equal(stored, contents);
  assert.equal(await readFile(path, 'utf8'), 'changed');
  assert.equal(await readRoleText('literal role', dir), 'literal role');
  await assert.rejects(readRoleText('@', dir), /file path is required/);
  await assert.rejects(readRoleText('@missing', dir), /Cannot read role file/);
  await writeFile(path, ' \n');
  await assert.rejects(readRoleText(`@${path}`, dir), /must not be empty/);
  await writeFile(path, 'é'.repeat(MAX_ROLE_BYTES));
  await assert.rejects(readRoleText(`@${path}`, dir), /32 KiB/);
});

test('~ resolves to the home directory and other paths resolve relative to cwd', () => {
  assert.equal(resolveRolePath('~', '/work'), homedir());
  assert.equal(resolveRolePath('~/role.md', '/work'), join(homedir(), 'role.md'));
  assert.equal(resolveRolePath('../role.md', '/work/project'), '/work/role.md');
  assert.equal(resolveRolePath('/tmp/role.md', '/work'), '/tmp/role.md');
});
