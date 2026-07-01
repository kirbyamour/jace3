// Model Gateway — the ONLY boundary between Jace and any model provider.
// Rules (blueprint doc 03 §2.3): no vendor SDK types outside this folder;
// no model-name strings outside config/models.json; every call is loggable.

export type ChatMessage = { role: "user" | "assistant" | "system"; content: string };

export type GenerateOptions = {
  modelId?: string;          // key into config/models.json; default = config.active
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
};

export type GenerateResult = {
  stream: ReadableStream<string>; // text deltas
  modelId: string;                // which registry entry actually served (after fallback)
};

export type ModelEntry = {
  adapter: "anthropic" | "openai-compatible" | "mock";
  model: string;
  envKey?: string;
  baseUrl?: string;
  label: string;
  maxTokens?: number;
};

export type ModelRegistry = {
  active: string;
  fallbackChain: string[];
  models: Record<string, ModelEntry>;
};

export type Adapter = (
  entry: ModelEntry,
  system: string,
  messages: ChatMessage[],
  opts: GenerateOptions
) => Promise<ReadableStream<string>>;
