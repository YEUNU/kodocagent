export type { ConfigLoadResult, KodocConfig, Provider, SetupValues } from "./config.js";
export {
  CURRENT_CONFIG_VERSION,
  DEFAULT_MODELS,
  KNOWN_MODELS,
  KodocConfigSchema,
  LAW_ENV_VAR,
  PROVIDER_ENV_VARS,
  PROVIDERS,
  parseConfigSafe,
  resolveApiKey,
  resolveModel,
  SetupValuesSchema,
} from "./config.js";
export { KORDOC_ERROR_MESSAGES, KodocError, kordocErrorMessage } from "./errors.js";
export {
  acquireInstanceLock,
  isPidAlive,
  KODOC_HOME,
  KODOC_LOCK_PATH,
  KODOC_PATHS,
  projectMcpConfigPath,
  releaseInstanceLock,
} from "./paths.js";
export type { PiiFinding, RedactRange } from "./pii.js";
export { detectPii, redactRanges, redactText, summarizePii } from "./pii.js";
export type { ApprovalHandler, ApprovalResult, Proposal, ProposalKind } from "./proposal.js";
