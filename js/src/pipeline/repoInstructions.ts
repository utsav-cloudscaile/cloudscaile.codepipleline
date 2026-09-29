/**
 * Formats CRUD-managed, per-repo standing instructions (src/db/repoInstructions.ts)
 * for injection into a stage's system prompt, alongside the repo-agnostic
 * master context (src/pipeline/masterContext.ts). Kept pure/dependency-free —
 * no DB access here — so it's unit-testable without Mongo; see
 * tests/pipeline/repoInstructions.test.ts.
 *
 * Wrapped in XML tags (`<repository_instructions>` / `<instruction>`) rather
 * than concatenated as plain text: the master context, these repo
 * instructions, and the caller's own task prompt are three distinct sources
 * layered into one conversation, and an unmarked concatenation gives the
 * model no way to tell where one ends and the next begins — Anthropic's own
 * prompting guidance is to delimit distinct context sections with XML tags
 * for exactly this reason. Each entry gets its own `<instruction name="...">`
 * so multiple named blocks (mirroring how GitHub Copilot supports several
 * `*.instructions.md` files, or Cursor several `.mdc` rule files, per repo)
 * stay individually attributable instead of blurring into one blob.
 */

export interface RepoInstructionContent {
  name: string;
  content: string;
}

/**
 * Returns '' when `instructions` is empty — callers should omit an empty
 * result from the system prompt entirely rather than append an empty tag
 * pair (see runStage, src/pipeline/index.ts).
 */
export function formatRepoInstructions(
  repoUrl: string,
  instructions: RepoInstructionContent[],
): string {
  if (instructions.length === 0) {
    return '';
  }
  const body = instructions
    .map(
      (instruction) =>
        `<instruction name="${escapeXmlAttribute(instruction.name)}">\n` +
        `${instruction.content.trim()}\n` +
        `</instruction>`,
    )
    .join('\n');
  return (
    `<repository_instructions repo="${escapeXmlAttribute(repoUrl)}">\n` +
    `${body}\n` +
    `</repository_instructions>`
  );
}

/** Escapes the five XML predefined entities for safe use inside a double-quoted attribute. */
function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
