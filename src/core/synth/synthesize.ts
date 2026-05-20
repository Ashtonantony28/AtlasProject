// Generate module-level and architecture-level docs grounded in the index.

import {
  type DB,
  getAllFiles,
  upsertDoc,
  getDoc,
} from '../db/index.js';
import { sha256 } from '../ingest/index.js';
import type { LLMClient } from './llmClient.js';
import { TokenBudget } from './budget.js';
import {
  buildModuleContext,
  buildArchitectureContext,
  moduleContextToPrompt,
  architectureContextToPrompt,
} from './context.js';

const MODULE_SYSTEM = `You are a senior engineer writing concise, accurate module documentation for a code intelligence tool.
Given the grounding context (symbols, imports, calls, and source excerpts), produce a short markdown summary that:
  - states the module's purpose in one sentence,
  - lists its public surface area as a bulleted list (name + one-line role),
  - notes important collaborators (modules it imports from or is called by),
  - keeps under 200 words.
Cite specific symbols and file:line locations from the context. Do not invent symbols that aren't listed.`;

const ARCHITECTURE_SYSTEM = `You are documenting a codebase at the architecture level for an internal reference.
Given the structural digest, write a concise overview in markdown:
  - a 1-2 sentence elevator pitch,
  - a "Modules" section listing the main files and their roles,
  - a "Key collaborations" section calling out the most connected files,
  - keep it under 250 words.
Stay grounded in what's listed. If something is unknown, say so briefly.`;

export interface SynthesizeOptions {
  root: string;
  tokenBudget: number;
  // Per-doc output token cap (passed to the LLM as max_tokens).
  perDocMaxTokens?: number;
  // Skip module docs whose source_hash is still current.
  force?: boolean;
  onProgress?: (e: { kind: 'module' | 'architecture'; path?: string; status: 'generated' | 'cached' | 'skipped'; reason?: string }) => void;
}

export interface SynthesizeStats {
  modulesGenerated: number;
  modulesCached: number;
  modulesSkipped: number;
  architectureGenerated: boolean;
  inputTokens: number;
  outputTokens: number;
  budgetRemaining: number;
  durationMs: number;
}

export async function synthesizeDocs(
  db: DB,
  llm: LLMClient,
  opts: SynthesizeOptions,
): Promise<SynthesizeStats> {
  const t0 = Date.now();
  const budget = new TokenBudget(opts.tokenBudget);
  const perDocMax = opts.perDocMaxTokens ?? 800;
  const stats: SynthesizeStats = {
    modulesGenerated: 0,
    modulesCached: 0,
    modulesSkipped: 0,
    architectureGenerated: false,
    inputTokens: 0,
    outputTokens: 0,
    budgetRemaining: budget.cap,
    durationMs: 0,
  };

  // 1) Module docs
  const files = getAllFiles(db);
  for (const file of files) {
    const ctx = buildModuleContext(db, opts.root, file);
    const cached = getDoc(db, 'file', file.id);
    if (!opts.force && cached && cached.source_hash === ctx.contentHash) {
      stats.modulesCached++;
      opts.onProgress?.({ kind: 'module', path: file.path, status: 'cached' });
      continue;
    }

    const prompt = moduleContextToPrompt(ctx);
    const estimateIn = Math.ceil(prompt.length / 4);
    if (budget.remaining() < estimateIn + perDocMax) {
      stats.modulesSkipped++;
      opts.onProgress?.({
        kind: 'module',
        path: file.path,
        status: 'skipped',
        reason: 'token budget exhausted',
      });
      continue;
    }

    const res = await llm.complete({
      system: MODULE_SYSTEM,
      messages: [{ role: 'user', content: prompt }],
      maxTokens: perDocMax,
      temperature: 0.2,
    });
    budget.record(res.inputTokens, res.outputTokens);
    stats.inputTokens += res.inputTokens;
    stats.outputTokens += res.outputTokens;
    upsertDoc(db, {
      target_kind: 'file',
      target_id: file.id,
      content: res.content,
      source_hash: ctx.contentHash,
    });
    stats.modulesGenerated++;
    opts.onProgress?.({ kind: 'module', path: file.path, status: 'generated' });
  }

  // 2) Architecture doc — keyed by id=0 under target_kind='architecture'.
  const archCtx = buildArchitectureContext(db);
  const archPrompt = architectureContextToPrompt(archCtx);
  const archHash = sha256(archPrompt);
  const archCached = getDoc(db, 'architecture', 0);
  if (!opts.force && archCached && archCached.source_hash === archHash) {
    opts.onProgress?.({ kind: 'architecture', status: 'cached' });
  } else if (budget.remaining() < Math.ceil(archPrompt.length / 4) + perDocMax) {
    opts.onProgress?.({
      kind: 'architecture',
      status: 'skipped',
      reason: 'token budget exhausted',
    });
  } else {
    const res = await llm.complete({
      system: ARCHITECTURE_SYSTEM,
      messages: [{ role: 'user', content: archPrompt }],
      maxTokens: perDocMax,
      temperature: 0.2,
    });
    budget.record(res.inputTokens, res.outputTokens);
    stats.inputTokens += res.inputTokens;
    stats.outputTokens += res.outputTokens;
    upsertDoc(db, {
      target_kind: 'architecture',
      target_id: 0,
      content: res.content,
      source_hash: archHash,
    });
    stats.architectureGenerated = true;
    opts.onProgress?.({ kind: 'architecture', status: 'generated' });
  }

  stats.budgetRemaining = budget.remaining();
  stats.durationMs = Date.now() - t0;
  return stats;
}
