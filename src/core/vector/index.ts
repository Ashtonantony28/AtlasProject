export {
  LocalHashEmbedder,
  tokenize,
  cosine,
} from './embedder.js';
export type { Embedder } from './embedder.js';
export {
  upsertEmbedding,
  getAllEmbeddings,
  countEmbeddings,
  deleteEmbeddingsForFile,
} from './store.js';
export { embedAllSymbols } from './embedAll.js';
export type { EmbedAllOptions, EmbedAllStats } from './embedAll.js';
export { search } from './search.js';
export type { SearchOptions, SearchHit } from './search.js';
export { buildSymbolText, makeSourceLoader, readFileFromRoot } from './textForSymbol.js';
