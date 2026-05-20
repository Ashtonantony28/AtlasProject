import { describe, expect, it } from 'vitest';
import { LocalHashEmbedder, cosine, tokenize } from '../../src/core/vector/index.js';

describe('tokenize', () => {
  it('splits camelCase and snake_case, lowercases, drops stopwords', () => {
    expect(tokenize('getUserById')).toEqual(['get', 'user', 'id']);
    expect(tokenize('user_profile_v2')).toEqual(['user', 'profile', 'v2']);
    // 'has' and 'the' are stopwords.
    expect(tokenize('TheCircleHasArea')).toEqual(['circle', 'area']);
  });
});

describe('LocalHashEmbedder', () => {
  it('produces L2-normalized vectors of the configured dim', async () => {
    const e = new LocalHashEmbedder(128);
    const [v] = await e.embed(['hello world']);
    expect(v).toBeDefined();
    expect(v!.length).toBe(128);
    let norm = 0;
    for (let i = 0; i < v!.length; i++) norm += v![i]! ** 2;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 5);
  });

  it('is deterministic across calls', async () => {
    const e = new LocalHashEmbedder();
    const [a] = await e.embed(['compute the total area']);
    const [b] = await e.embed(['compute the total area']);
    expect(cosine(a!, b!)).toBeCloseTo(1, 5);
  });

  it('related queries score higher than unrelated ones', async () => {
    const e = new LocalHashEmbedder();
    const [q] = await e.embed(['circle area radius']);
    const [related] = await e.embed(['function: Circle.area — returns area of a circle']);
    const [unrelated] = await e.embed(['Python counter increment value']);
    expect(cosine(q!, related!)).toBeGreaterThan(cosine(q!, unrelated!));
  });
});
