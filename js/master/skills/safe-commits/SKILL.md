---
name: safe-commits
description: Use when finishing a pipeline run that ends in a commit/push — how to size, message, and verify the change before it leaves the workspace.
---

# Safe commits

This pipeline's commits/pushes are not reviewed by a human before they reach
the remote (see `pipeline.policy.example.json` — `git_push` is plain-allow).
That makes the commit step itself the last checkpoint:

1. **Diff review** — before committing, look at the actual diff
   (`git_diff`/`git_status`) and confirm it only contains the intended
   change. Stray debug output, commented-out code, or accidental file
   deletions should never reach a commit.
2. **One logical change per commit** — don't mix the requested feature with
   incidental fixes; if you notice something else that needs fixing, mention
   it in your final summary instead of folding it into this commit.
3. **Verify before you commit, not after** — run whatever build/lint/test the
   target repo supports first (see `master/INSTRUCTIONS.md`); a commit that's
   about to be pushed unattended should be one you'd stand behind un-reviewed.
4. **Message** — first line is a concise summary of *what*, imperative mood
   (matches most repos' convention); a short body explains *why* if it's not
   obvious from the summary alone.
5. **Push** — push the branch the workspace is already on; don't create or
   switch branches unless the prompt specifically asked for that.
