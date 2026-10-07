---
name: recap
description: One-line recap of what the user got done recently across their Claude Code and Codex sessions and git commits, plus what is waiting on them. Use when they ask what they did or worked on in the last few hours or today, want a recap, standup or end-of-day summary, ask which chats need them, or say "check my claude and codex sessions".
---

# Recap

Run the `recap` command and show its output as-is. It is already the final format: a "Needs you" list followed by one line per piece of work.

```bash
recap <range> --format md
```

`<range>` is one of `3h`, `6h` (default), `12h`, `24h`, `2d` or `today`. Map the request: "last few hours" → `6h`, "today" or "end of day" → `today`, "since yesterday" → `24h`.

If `recap` is not on PATH, run `node <recap checkout>/bin/recap.mjs` instead (the folder this skill links to, one level up).

A recap takes 10 to 30 seconds. To list only the chats waiting on the person, which is instant and uses no model, run:

```bash
recap needs --format md
```

## Presenting it

- Paste the markdown output without rewording, reordering or adding lines; the person wants one-liners, not prose.
- Add nothing else unless the run failed. Then say in one line what failed and what fixes it (for example: no summarizer is set up, so connect OpenRouter or a local model in Recap's settings, or sign in to the Codex CLI).

## Options

- `--digest` prints the raw collected log (prompts, agent reports, commits) instead of the summary. Use it when the person asks for detail on one item.
- `--engine openrouter|local|codex|claude` and `--model <id>` pick the summarizer for one run.
