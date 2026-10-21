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
import { modulePrompt, architecturePrompt } from './context.js';

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
  // Regenerate even docs whose source_hash (sha256 of the prompt) is unchanged.
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

  // A doc is cached iff sha256(prompt) matches its source_hash. A call runs
  // only if its worst case (~3 chars/token in, perDocMax out) fits the budget.
  const generate = async (
    kind: 'module' | 'architecture',
    system: string,
    prompt: string,
    target: { kind: 'file' | 'architecture'; id: number; path?: string },
  ): Promise<'generated' | 'cached' | 'skipped'> => {
    const hash = sha256(prompt);
    const cached = getDoc(db, target.kind, target.id);
    const path = target.path !== undefined ? { path: target.path } : {};
    if (!opts.force && cached?.source_hash === hash) {
      opts.onProgress?.({ kind, ...path, status: 'cached' });
      return 'cached';
    }
    if (budget.remaining() < Math.ceil((system.length + prompt.length) / 3) + perDocMax) {
      opts.onProgress?.({ kind, ...path, status: 'skipped', reason: 'token budget exhausted' });
      return 'skipped';
    }
    const res = await llm.complete({
      system,
      messages: [{ role: 'user', content: prompt }],
      maxTokens: perDocMax,
      temperature: 0.2,
    });
    budget.record(res.inputTokens, res.outputTokens);
    stats.inputTokens += res.inputTokens;
    stats.outputTokens += res.outputTokens;
    upsertDoc(db, {
      target_kind: target.kind,
      target_id: target.id,
      content: res.content,
      source_hash: hash,
    });
    opts.onProgress?.({ kind, ...path, status: 'generated' });
    return 'generated';
  };

  // 1) Module docs
  for (const file of getAllFiles(db)) {
    const prompt = modulePrompt(db, opts.root, file);
    const r = await generate('module', MODULE_SYSTEM, prompt, { kind: 'file', id: file.id, path: file.path });
    if (r === 'generated') stats.modulesGenerated++;
    else if (r === 'cached') stats.modulesCached++;
    else stats.modulesSkipped++;
  }

  // 2) Architecture doc — keyed by id=0 under target_kind='architecture'.
  const arch = await generate('architecture', ARCHITECTURE_SYSTEM, architecturePrompt(db), {
    kind: 'architecture',
    id: 0,
  });
  stats.architectureGenerated = arch === 'generated';

  stats.budgetRemaining = budget.remaining();
  stats.durationMs = Date.now() - t0;
  return stats;
}
