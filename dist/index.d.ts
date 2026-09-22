import type { Context } from '@deepseek-ai/cordis';
import { LlmAdapter, type GenerateOptions, type LlmProviderInfo, type LlmModelInfo, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm';
declare module '@deepseek-ai/cordis' {
    interface Context {
        compaction: any;
        agents?: any;
        agent?: any;
    }
    interface Events {
        'agent/request-error': any;
        'agent/turn-stopping': any;
        'agent/disposed': any;
    }
}
export declare const name = "dsh-antigravity-empty-response-recovery";
export declare const inject: readonly ["llm"];
export interface Config {
    enabled: boolean;
    interceptAllProviders: boolean;
    providers: string[];
    upstreamBaseUrl: string;
    apiKey?: string;
    timeoutMs: number;
    retryOriginal: number;
    retryWithNudge: boolean;
    nudgePrompt: string;
    enableToolChoiceNone: boolean;
    compactAfterToolChoiceNone: boolean;
    postCompactionRetry: number;
    syntheticFallback: boolean;
    syntheticResponse: string;
    targetModels: string[];
    logFilePath?: string;
    logLevel: 'silent' | 'error' | 'warn' | 'info' | 'debug';
    registerStandaloneAdapter?: boolean;
    includeRequestBodyInDebugLog: boolean;
}
export declare const Config: any;
declare const EMPTY_RESPONSE = "EMPTY_RESPONSE";
declare const COMPACTION_REQUIRED = "ANTIGRAVITY_EMPTY_RESPONSE_COMPACTION_REQUIRED";
declare const SYNTHETIC_REQUIRED = "ANTIGRAVITY_EMPTY_RESPONSE_SYNTHETIC_REQUIRED";
declare class FileLogger {
    private logPath;
    private level;
    constructor(logPath: string, level: Config['logLevel']);
    setLevel(level: Config['logLevel']): void;
    write(level: Config['logLevel'], tag: string, message: string, data?: unknown): void;
}
declare function syntheticStream(text: string): AsyncIterable<StreamChunk>;
declare class RecoveryAdapter extends LlmAdapter {
    private readonly ctx;
    private readonly config;
    private readonly log;
    private readonly getAgent?;
    constructor(ctx: Context, config: Config, log: (level: Config['logLevel'], message: string, data?: unknown) => void, getAgent?: ((options: GenerateOptions) => any) | undefined);
    providerInfo(provider: string): LlmProviderInfo;
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo>;
    private resolveAgent;
    stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
    private single;
    private collect;
}
export declare function apply(ctx: Context, config: Config): void;
export { EMPTY_RESPONSE, COMPACTION_REQUIRED, SYNTHETIC_REQUIRED, RecoveryAdapter, syntheticStream, FileLogger };
