/**
 * Loads the standing "master" context — baseline instructions plus a set of
 * repo-agnostic skills (see master/INSTRUCTIONS.md, master/skills) — that
 * gets prepended to every pipeline stage's prompt, on top of whatever a
 * specific run/prompt adds. Kept as a plain async function (no SDK types)
 * so it's unit-testable against a fixture directory — see
 * tests/pipeline/masterContext.test.ts.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const SECTION_SEPARATOR = '\n\n---\n\n';

/**
 * Reads masterDir's INSTRUCTIONS.md and every SKILL.md under masterDir's
 * skills subdirectories, concatenating them into a single string in a
 * stable (alphabetical by skill directory name) order. Missing files or
 * directories are treated as empty, not an error — a repo can ship a
 * master directory with only instructions and no skills yet, or vice versa.
 */
export async function loadMasterContext(masterDir = 'master'): Promise<string> {
  const sections: string[] = [];

  const instructions = await readOptional(path.join(masterDir, 'INSTRUCTIONS.md'));
  if (instructions !== undefined) {
    sections.push(instructions.trim());
  }

  for (const skillFile of await listSkillFiles(path.join(masterDir, 'skills'))) {
    const content = await readOptional(skillFile);
    if (content !== undefined) {
      sections.push(content.trim());
    }
  }

  return sections.join(SECTION_SEPARATOR);
}

async function readOptional(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch (error) {
    if (isEnoent(error)) {
      return undefined;
    }
    throw error;
  }
}

/** Lists each skill directory's SKILL.md file under skillsDir, sorted by directory name. */
async function listSkillFiles(skillsDir: string): Promise<string[]> {
  const names = await readdir(skillsDir, { withFileTypes: true })
    .then((entries) => entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name))
    .catch((error: unknown) => {
      if (isEnoent(error)) {
        return [];
      }
      throw error;
    });
  return names.sort().map((name) => path.join(skillsDir, name, 'SKILL.md'));
}

function isEnoent(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
