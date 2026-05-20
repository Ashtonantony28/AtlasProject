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
} from './context.js';
export type { ModuleContext, ArchitectureContext } from './context.js';
