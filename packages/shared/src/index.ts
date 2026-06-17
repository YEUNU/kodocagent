export type { KodocConfig, Provider } from "./config.js";
export {
  DEFAULT_MODELS,
  KNOWN_MODELS,
  KodocConfigSchema,
  LAW_ENV_VAR,
  PROVIDER_ENV_VARS,
  PROVIDERS,
  resolveApiKey,
  resolveModel,
} from "./config.js";
export { KORDOC_ERROR_MESSAGES, KodocError, kordocErrorMessage } from "./errors.js";
export { KODOC_HOME, KODOC_PATHS, projectMcpConfigPath } from "./paths.js";
export type { PiiFinding } from "./pii.js";
export { detectPii, summarizePii } from "./pii.js";
export type { ApprovalHandler, ApprovalResult, Proposal, ProposalKind } from "./proposal.js";
