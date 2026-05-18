# pi-loop

Claude Code-style `/loop` command for [pi](https://pi.dev).

`pi-loop` adds an autonomous loop command that keeps sending follow-up turns until the agent reports completion, gets blocked, or hits a max-iteration guardrail.

## Install

From npm:

```bash
pi install npm:@usirin/pi-loop
```

Try without installing:

```bash
pi -e npm:@usirin/pi-loop
```

Install from git:

```bash
pi install git:github.com/usirin/pi-loop
```

Install from a local checkout:

```bash
pi install /path/to/pi-loop
```

After install, restart pi or run:

```text
/reload
```

## Usage

```text
/loop <objective>
/loop 3m <objective>
/loop --interval 30s <objective>
/loop --max 10 <objective>
/loop 10 <objective>
/loop status
/loop pause
/loop resume
/loop stop
```

Examples:

```text
/loop --max 8 inspect this repo, add the smallest useful test/build setup, and stop when everything passes
```

```text
/loop 5 fix the failing tests, running the relevant test command after each change
```

Run every three minutes, like Claude Code's interval form:

```text
/loop 3m take a look at these prs and fix the reviews
```

## How it stops

A loop stops when one of these happens:

- the assistant calls the `loop_done` tool
- the assistant includes `LOOP_DONE` in its response
- you run `/loop stop`
- the max iteration count is reached
- the session shuts down

Default max iterations: `25`.

## How it works

The extension registers:

- `/loop` slash command
- `loop_done` tool for the model to stop the loop explicitly
- a status/widget display showing the active loop objective and iteration count

Each iteration instructs the model to do exactly one useful slice of work. If the model does not stop the loop, the extension queues the next follow-up turn. When an interval is provided, the first turn starts immediately and subsequent turns wait for that interval.

## Package metadata

This is a pi package. The extension is declared in `package.json`:

```json
{
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions/loop.ts"]
  }
}
```

## Development

Run from a checkout without installing:

```bash
pi -e ./extensions/loop.ts
```

Check the npm tarball contents:

```bash
npm run pack:dry-run
```

## Security

Pi extensions run with your full system permissions. Review any extension source before installing it.
