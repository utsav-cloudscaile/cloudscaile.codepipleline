---
name: respect-target-conventions
description: Use before making any change in the target repo — orient to its existing conventions instead of importing conventions from elsewhere.
---

# Respect the target repo's conventions

Before editing, spend a few tool calls orienting:

1. **Formatting/linting** — look for `.eslintrc*`, `.prettierrc*`,
   `biome.json`, `.editorconfig`, `ruff`/`black` config, etc. Match whatever
   is configured; don't introduce a second formatter's opinions.
2. **Structure** — look at how similar existing code is organized (file
   layout, naming, module boundaries) and follow the same pattern for new
   code, rather than the structure you'd default to in a blank repo.
3. **Dependencies** — check `package.json`/lockfile (or the equivalent for
   the language in use) before adding a new library; prefer what's already a
   dependency if it can do the job, and use the same package manager the repo
   already uses (don't introduce a second lockfile).
4. **Tests** — if there's an existing test directory/framework, add tests in
   that style and location rather than a different one.

If the target repo has its own `CLAUDE.md` or `.claude/skills/`, those take
precedence over general defaults — read them first.
