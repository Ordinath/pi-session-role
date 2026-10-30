# pi-session-role

Give one Pi session its own system-prompt role. The role follows the saved session
through restart, resume, re-hosting and compaction, but not into forks.

## Install

Requires Node.js 20 or later and Pi's structured prompt-section API (tested with Pi 1.4.0).

```sh
pi install npm:pi-session-role
```

## Use

```text
/role set Be terse.
/role set @./roles/reviewer.md
/role set @~/roles/reviewer.md
/role show
/role clear
```

File paths resolve relative to the session's working directory; `~` means your
home directory. Everything after `@` is the path, including spaces; don't quote it.
The file is read once as UTF-8. Later edits or deletion do not change the saved role.
Empty or whitespace-only roles and roles over 32 KiB of UTF-8 bytes are rejected.

`/role show` displays the active role, or explains that a parent's role is being
ignored in a fork. Commands report through Pi notifications, including in RPC mode.
For pi-web or Herdr clients, send the command as an ordinary RPC prompt:

```json
{"type":"prompt","message":"/role set Be terse."}
```

Pi executes registered extension commands before model work and responds with
`data.disposition: "handled"`. The command itself makes no model call. Use `prompt`,
not RPC `steer` or `follow_up`, which do not accept extension commands.

## Storage and forks

Each change appends a `session-role` custom entry containing `sessionId`, `text`
and an ISO `setAt` timestamp. Clear stores an empty string. The latest matching
entry on the **current branch** wins; navigating to another branch restores that
branch's role. Entries are not conversation messages.

Before every run, including custom-message runs, the extension reads the current
branch and adds a `session_role` system-prompt section in place:

```text
Session role (set by the user for this session):
Be terse.
```

Pi records section changes as transcript deltas; the extension does not replace
the entire system prompt. With no active role, it leaves prompt sections alone.

An entry applies only when its stored session ID matches the current session ID.
Forks copy history but get a new ID, so the parent's role is ignored. This applies
to `--fork`, `/fork` and any client that forks through Pi's session API.
A fork can set its own role. Moving a saved session without changing its ID keeps
its role. There is no separate configuration or role file to move.

## Limits

- Pi 1.4 does not write a brand-new session to disk until its first ordinary chat
  message. Setting a role and quitting before that message cannot persist it.
  `--no-session` is also in-memory only.
- Clear stops applying the role; it does not erase previous entries or historical
  prompt sections from the session file. Roles are stored as plain text, not secrets.
- A role is a prompt instruction, not a security boundary or a guarantee of model behavior.
- The extension must be loaded by the host. A host that changes the session ID is
  treated as a fork. Client-specific UI delivery is up to the RPC client.

## Development

```sh
npm ci
npm run typecheck
npm test
```

No build step: Pi loads `pi/index.ts` directly. Tests require `pi` 1.4.0 on PATH.
The RPC integration test loads the source with `-e ./pi/index.ts`, uses temporary
HOME/agent/session directories and a localhost-only provider, and makes no paid
API calls. It checks command dispatch, actual provider payloads, restart/resume,
re-hosting, compaction, custom-message runs, fork isolation and file snapshots.
Temporary processes and files are removed when the test finishes. Live Pi settings
and installed extensions are not used or changed.
