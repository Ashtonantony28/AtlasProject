import { describe, expect, it } from 'vitest';
import { createEmbedder } from '../../src/core/vector/index.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';

describe('contract: createEmbedder', () => {
  it('returns local-hash-v1 at dim 384 by default', async () => {
    const e = createEmbedder(DEFAULT_CONFIG);
    expect(e.model).toBe('local-hash-v1');
    expect(e.dim).toBe(384);
    const [v] = await e.embed(['hello world']);
    expect(v?.length).toBe(384);
  });

  it('throws a clear error on unknown models', () => {
    expect(() => createEmbedder({ embeddingModel: 'nope-v9' })).toThrow(
      /Unknown embeddingModel "nope-v9"/,
    );
  });
});
