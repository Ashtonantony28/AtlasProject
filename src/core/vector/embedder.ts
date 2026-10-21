// Embedder interface + the dependency-free 'local-hash-v1' implementation.
// This is intentionally deterministic and offline so tests + CI don't burn API
// quota. A real provider (Voyage / Anthropic) can be plugged in behind the
// same interface in a later phase.

import type { AtlasConfig } from '../config.js';

export interface Embedder {
  /** Friendly model id stored alongside vectors. */
  readonly model: string;
  /** Output dimensionality. */
  readonly dim: number;
  /** Embed one or more strings. Returns Float32Array per input. */
  embed(inputs: string[]): Promise<Float32Array[]>;
}

const STOPWORDS = new Set<string>([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have', 'in',
  'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was', 'were',
  'with', 'will', 'shall', 'can', 'cannot',
]);

/** Tokenize a string: identifier-aware (splits camelCase / snake_case), lowercased. */
export function tokenize(s: string): string[] {
  // Split on non-alphanumeric and camelCase boundaries.
  const parts: string[] = [];
  for (const raw of s.split(/[^A-Za-z0-9_]+/)) {
    if (!raw) continue;
    // Split snake_case
    for (const seg of raw.split('_')) {
      if (!seg) continue;
      // Split camelCase: "fooBarBaz" -> ["foo", "Bar", "Baz"]
      const camel = seg.split(/(?=[A-Z])/);
      for (const piece of camel) {
        const lc = piece.toLowerCase();
        if (lc.length < 2) continue;
        if (STOPWORDS.has(lc)) continue;
        parts.push(lc);
      }
    }
  }
  return parts;
}

/** FNV-1a 32-bit hash. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * 'local-hash-v1': hash each token into a fixed-dim sparse vector, accumulate
 * with sign bits derived from a secondary hash, then L2-normalize. This is the
 * canonical "feature hashing" trick (Weinberger et al.) — produces a
 * deterministic, language-agnostic dense embedding that's surprisingly useful
 * for short-text similarity over a small corpus.
 */
export class LocalHashEmbedder implements Embedder {
  readonly model = 'local-hash-v1';
  readonly dim: number;

  constructor(dim = 384) {
    this.dim = dim;
  }

  async embed(inputs: string[]): Promise<Float32Array[]> {
    return inputs.map((s) => this.embedOne(s));
  }

  embedOne(text: string): Float32Array {
    const vec = new Float32Array(this.dim);
    const tokens = tokenize(text);
    for (const t of tokens) {
      const h1 = fnv1a(t);
      const h2 = fnv1a('S\x00' + t);
      const idx = h1 % this.dim;
      const sign = (h2 & 1) === 0 ? 1 : -1;
      vec[idx] = (vec[idx] ?? 0) + sign;
    }
    // L2 normalize
    let norm = 0;
    for (let i = 0; i < this.dim; i++) norm += (vec[i] ?? 0) ** 2;
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < this.dim; i++) vec[i] = (vec[i] ?? 0) / norm;
    }
    return vec;
  }
}

/** Cosine similarity for normalized vectors is just the dot product. */
export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
}

/** Pick the embedder named by `config.embeddingModel`. */
export function createEmbedder(config: Pick<AtlasConfig, 'embeddingModel'>): Embedder {
  switch (config.embeddingModel) {
    case 'local-hash-v1':
      return new LocalHashEmbedder();
    default:
      throw new Error(
        `Unknown embeddingModel "${config.embeddingModel}". Supported: local-hash-v1.`,
      );
  }
}
