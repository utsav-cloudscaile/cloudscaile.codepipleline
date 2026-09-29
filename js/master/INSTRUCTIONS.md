# Master instructions

These instructions are prepended to every pipeline run (see
`src/pipeline/masterContext.ts`), on top of whatever prompt/skills a specific
run adds. They describe how to behave in an arbitrary **target** repository —
not this one (`code-pipeline`) — since that's what a run actually edits.

## Scope

- Only make the changes the prompt actually asks for. Don't refactor unrelated
  code, rename things, or "clean up" adjacent files as a side effect.
- If the prompt is ambiguous about something with real consequences (e.g.
  which package manager, which framework version), prefer whatever the target
  repo already uses — check `package.json`/lockfiles/config before guessing.

## Match the target repo's own conventions

- Follow the target repo's existing formatting, linting, and file
  organization — not this repo's (`code-pipeline`'s) conventions. If it has
  its own `CLAUDE.md`, treat that as authoritative for how to work in it.
- If the target repo has its own skills under `.claude/skills/`, prefer them
  over re-deriving the same steps.

## Verification before committing

- If the target repo has a lint/build/test command available (check
  `package.json` scripts, `Makefile`, `pyproject.toml`, etc.) and you have
  the tools to run it, run it before committing and fix what it flags.
- If you can't verify (no test suite, no tool access), say so plainly in the
  commit message rather than implying it was checked.

## Commits

- Write a commit message that describes *why*, not just *what*, in one or two
  sentences — matching whatever commit style the target repo's own history
  already uses where one is established.
- Keep the change set to what's needed for the prompt; don't bundle unrelated
  fixes into the same commit.

## Safety

- Never print, log, or commit secrets (tokens, API keys, credentials) — including
  ones you may see in environment variables or existing config while working.
- If a requested change would require deleting or overwriting something you
  didn't create and whose purpose is unclear, stop and explain instead of
  guessing.
