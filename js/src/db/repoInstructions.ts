/**
 * CRUD data access for the /v1/repo-instructions API (src/server/routes/v1/repo-instructions.ts) —
 * named instruction blocks associated with a repo (and only a repo — not
 * whichever caller happens to manage or trigger it) that /v1/trigger layers
 * into a stage's system prompt (see src/pipeline/repoInstructions.ts's
 * formatRepoInstructions, and `listActiveForRepo` below, the read path that
 * feeds it). Every authenticated caller who triggers a given repo shares the
 * same instruction set for it, the same way a file committed to that repo
 * would apply regardless of who runs the agent — there is no per-user
 * ownership here (unlike `SessionQueries`, which is scoped by the caller's
 * JWT `sub`).
 *
 * `repoSlug` (src/mcp/git/workspace.ts — the same derivation `sessions`/`runs`
 * use) is the actual lookup key, not `repoUrl` string equality: two callers
 * writing `.../widgets.git` and `.../widgets` should hit the same instruction
 * set. `RepoInstructionQueries` is the test seam
 * (`BuildServerOptions.repoInstructionQueries`), same pattern as
 * `SessionQueries`/`UsageQueries`.
 */
import { repoSlug as deriveRepoSlug } from '@/mcp/git/workspace.js';
import type { RepoInstructionContent } from '@/pipeline/index.js';
import { RepoInstructionModel } from './models.js';
import type { Page, PageRequest } from './queries.js';
import { requireConnected } from './queries.js';

export interface RepoInstructionDTO {
  id: string;
  repoUrl: string;
  repoSlug: string;
  name: string;
  content: string;
  enabled: boolean;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
}

export interface CreateRepoInstructionInput {
  repoUrl: string;
  name: string;
  content: string;
  enabled?: boolean;
}

export interface UpdateRepoInstructionInput {
  name?: string | undefined;
  content?: string | undefined;
  enabled?: boolean | undefined;
}

export interface RepoInstructionQueries {
  /** All instruction blocks, optionally narrowed to one repo, most recently updated first. */
  list(repoUrl: string | undefined, page: PageRequest): Promise<Page<RepoInstructionDTO>>;
  /** Null when no block with this id exists. */
  getById(id: string): Promise<RepoInstructionDTO | null>;
  /** Throws a `statusCode: 409` error when `(repoUrl, name)` already exists. */
  create(input: CreateRepoInstructionInput): Promise<RepoInstructionDTO>;
  /** Null when missing. Throws `statusCode: 409` on a rename that collides with another entry on the same repo. */
  update(id: string, patch: UpdateRepoInstructionInput): Promise<RepoInstructionDTO | null>;
  /** True if a doc was deleted; false when no block with this id existed. */
  remove(id: string): Promise<boolean>;
  /**
   * Enabled instructions for `repoUrl`, sorted by name for deterministic
   * prompt content across runs — the read path POST /v1/trigger uses to
   * build the system prompt (see formatRepoInstructions,
   * src/pipeline/repoInstructions.ts). Unlike the rest of this interface,
   * never throws on a bad `repoUrl` — trigger only ever calls this with the
   * already-`z.url()`-validated body field.
   */
  listActiveForRepo(repoUrl: string): Promise<RepoInstructionContent[]>;
}

function conflict(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 409 });
}

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { statusCode: 400 });
}

/** `repoSlug()` throws on a URL it can't derive a slug from — surfaced as a 400, not a 500. */
function safeRepoSlug(repoUrl: string): string {
  try {
    return deriveRepoSlug(repoUrl);
  } catch {
    throw badRequest(`Could not derive a repo slug from repoUrl: "${repoUrl}"`);
  }
}

const iso = (value: unknown): string | undefined =>
  value instanceof Date ? value.toISOString() : undefined;

interface RepoInstructionLeanDoc {
  _id: unknown;
  repoUrl: string;
  repoSlug: string;
  name: string;
  content: string;
  enabled?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

function toDTO(doc: RepoInstructionLeanDoc): RepoInstructionDTO {
  const createdAt = iso(doc.createdAt);
  const updatedAt = iso(doc.updatedAt);
  return {
    id: String(doc._id),
    repoUrl: doc.repoUrl,
    repoSlug: doc.repoSlug,
    name: doc.name,
    content: doc.content,
    enabled: doc.enabled ?? true,
    ...(createdAt !== undefined && { createdAt }),
    ...(updatedAt !== undefined && { updatedAt }),
  };
}

export const repoInstructionQueries: RepoInstructionQueries = {
  async list(repoUrl, { page, limit }) {
    requireConnected();
    const filter = repoUrl !== undefined ? { repoSlug: safeRepoSlug(repoUrl) } : {};
    const [docs, total] = await Promise.all([
      RepoInstructionModel.find(filter)
        .sort({ updatedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      RepoInstructionModel.countDocuments(filter),
    ]);
    return { items: docs.map(toDTO), total };
  },

  async getById(id) {
    requireConnected();
    const doc = await RepoInstructionModel.findOne({ _id: id }).lean();
    return doc === null ? null : toDTO(doc);
  },

  async create(input) {
    requireConnected();
    const repoSlug = safeRepoSlug(input.repoUrl);
    const existing = await RepoInstructionModel.findOne({ repoSlug, name: input.name })
      .select({ _id: 1 })
      .lean();
    if (existing !== null) {
      throw conflict(
        `A repo instruction named "${input.name}" already exists for this repo. Use PATCH to update it.`,
      );
    }
    const doc = await RepoInstructionModel.create({
      repoUrl: input.repoUrl,
      repoSlug,
      name: input.name,
      content: input.content,
      ...(input.enabled !== undefined && { enabled: input.enabled }),
    });
    return toDTO(doc.toObject());
  },

  async update(id, patch) {
    requireConnected();
    const current = await RepoInstructionModel.findOne({ _id: id });
    if (current === null) {
      return null;
    }
    if (patch.name !== undefined && patch.name !== current.name) {
      const collision = await RepoInstructionModel.findOne({
        _id: { $ne: current._id },
        repoSlug: current.repoSlug,
        name: patch.name,
      })
        .select({ _id: 1 })
        .lean();
      if (collision !== null) {
        throw conflict(`A repo instruction named "${patch.name}" already exists for this repo.`);
      }
      current.name = patch.name;
    }
    if (patch.content !== undefined) {
      current.content = patch.content;
    }
    if (patch.enabled !== undefined) {
      current.enabled = patch.enabled;
    }
    await current.save();
    return toDTO(current.toObject());
  },

  async remove(id) {
    requireConnected();
    const result = await RepoInstructionModel.deleteOne({ _id: id });
    return result.deletedCount > 0;
  },

  async listActiveForRepo(repoUrl) {
    requireConnected();
    const docs = await RepoInstructionModel.find({
      repoSlug: deriveRepoSlug(repoUrl),
      enabled: true,
    })
      .sort({ name: 1 })
      .select({ name: 1, content: 1 })
      .lean();
    return docs.map((doc) => ({ name: doc.name, content: doc.content }));
  },
};
