export { synthesizeDocs } from './synthesize.js';
export type { SynthesizeOptions, SynthesizeStats } from './synthesize.js';
export {
  createAnthropicClient,
  createOfflineClient,
} from './llmClient.js';
export type { LLMClient, LLMResult, LLMCallParams, LLMMessage } from './llmClient.js';
export { TokenBudget } from './budget.js';
export {
  buildModuleContext,
  buildArchitectureContext,
  moduleContextToPrompt,
  architectureContextToPrompt,
  modulePrompt,
  architecturePrompt,
  MAX_MODULE_PROMPT_CHARS,
  MAX_ARCH_PROMPT_CHARS,
} from './context.js';
export { docsFromDb, exportDocs, readPersistedDocs, importPersistedDocs } from './persist.js';
export type { PersistedDoc } from './persist.js';
export type { ModuleContext, ArchitectureContext } from './context.js';
