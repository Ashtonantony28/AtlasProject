// Inserts minimal docs directly so tests that need the "all docs in sync" state
// don't depend on the LLM synthesis path (which was removed in favor of MCP).
import type { DB } from '../../src/core/db/index.js';
import { getAllFiles, getSymbolsForFile, upsertDoc } from '../../src/core/db/index.js';
import {
  buildArchitectureContext,
  architectureContextToPrompt,
} from '../../src/core/graph/context.js';
import { sha256 } from '../../src/core/ingest/index.js';

export function insertMockDocs(db: DB): void {
  const files = getAllFiles(db);
  for (const file of files) {
    const symbols = getSymbolsForFile(db, file.id).filter((s) => s.kind !== 'module');
    const symbolNames = symbols.map((s) => s.qualified_name ?? s.name);
    // Content deliberately mentions every public symbol name so drift detection
    // considers all symbols documented.
    const content =
      `# ${file.path}\n\n` + symbolNames.map((n) => `- \`${n}\``).join('\n') + '\n';
    upsertDoc(db, {
      target_kind: 'file',
      target_id: file.id,
      content,
      source_hash: file.content_hash,
    });
  }

  const archCtx = buildArchitectureContext(db);
  const archPrompt = architectureContextToPrompt(archCtx);
  const archHash = sha256(archPrompt);
  const archContent =
    `# Architecture\n\n` +
    files.map((f) => `- ${f.path} [${f.language}]`).join('\n') +
    '\n';
  upsertDoc(db, {
    target_kind: 'architecture',
    target_id: 0,
    content: archContent,
    source_hash: archHash,
  });
}
