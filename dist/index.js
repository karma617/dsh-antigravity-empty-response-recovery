import Schema from '@deepseek-ai/schemastery';
import { LlmAdapter, LlmError, } from '@deepseek-ai/dsh-llm';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
export const name = 'dsh-antigravity-empty-response-recovery';
export const inject = ['llm'];
export const Config = Schema.object({
    enabled: Schema.boolean().default(true),
    interceptAllProviders: Schema.boolean().default(true),
    providers: Schema.array(Schema.string()).default(['sub2api-antigravity-recovery', 'gemini']),
    upstreamBaseUrl: Schema.string().default('http://127.0.0.1:3000/v1'),
    apiKey: Schema.string().default(''),
    timeoutMs: Schema.number().min(1000).max(600000).default(300000),
    retryOriginal: Schema.number().min(0).max(2).default(1),
    retryWithNudge: Schema.boolean().default(true),
    nudgePrompt: Schema.string().default('上一个操作已执行完毕。请分析当前执行结果并继续完成任务或输出结论。'),
    enableToolChoiceNone: Schema.boolean().default(true),
    compactAfterToolChoiceNone: Schema.boolean().default(true),
    postCompactionRetry: Schema.number().min(0).max(1).default(1),
    syntheticFallback: Schema.boolean().default(true),
    syntheticResponse: Schema.string().default('已自动捕获并恢复前序空响应。当前任务上下文已完整保留，请继续下一步操作。'),
    targetModels: Schema.array(Schema.string()).default([
        'gemini',
        'antigravity',
        'flash',
    ]),
    logFilePath: Schema.string().default(''),
    logLevel: Schema.union([
        Schema.const('silent'), Schema.const('error'), Schema.const('warn'), Schema.const('info'), Schema.const('debug'),
    ]).default('info'),
    registerStandaloneAdapter: Schema.boolean().default(false),
    includeRequestBodyInDebugLog: Schema.boolean().default(false),
});
const EMPTY_RESPONSE = 'EMPTY_RESPONSE';
const COMPACTION_REQUIRED = 'ANTIGRAVITY_EMPTY_RESPONSE_COMPACTION_REQUIRED';
const SYNTHETIC_REQUIRED = 'ANTIGRAVITY_EMPTY_RESPONSE_SYNTHETIC_REQUIRED';
function now() { return new Date().toISOString(); }
function getDefaultLogPath() {
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    return path.join(home, 'antigravity-recovery.log');
}
class FileLogger {
    logPath;
    level;
    constructor(logPath, level) {
        this.logPath = logPath || getDefaultLogPath();
        this.level = level;
        try {
            const dir = path.dirname(this.logPath);
            fs.mkdirSync(dir, { recursive: true });
        }
        catch { }
    }
    setLevel(level) {
        this.level = level;
    }
    write(level, tag, message, data) {
        if (this.level === 'silent')
            return;
        const rank = { silent: 99, error: 0, warn: 1, info: 2, debug: 3 };
        if (rank[level] > rank[this.level])
            return;
        const ts = now();
        const lvlStr = level.toUpperCase().padEnd(5);
        let dataStr = '';
        if (data !== undefined) {
            try {
                dataStr = ' ' + JSON.stringify(data);
            }
            catch {
                dataStr = ' [Circular/Unserializable]';
            }
        }
        const line = `[${ts}] [${lvlStr}] [${tag}] ${message}${dataStr}\n`;
        if (level === 'error')
            console.error(line.trimEnd());
        else if (level === 'warn')
            console.warn(line.trimEnd());
        else if (this.level === 'debug')
            console.log(line.trimEnd());
        try {
            // Rotate if file exceeds 10MB
            try {
                const stat = fs.statSync(this.logPath);
                if (stat.size > 10 * 1024 * 1024) {
                    const bak = this.logPath + '.1';
                    try {
                        if (fs.existsSync(bak))
                            fs.unlinkSync(bak);
                    }
                    catch { }
                    fs.renameSync(this.logPath, bak);
                }
            }
            catch { }
            fs.appendFileSync(this.logPath, line, 'utf8');
        }
        catch {
            // Ignore write errors to prevent host crashes
        }
    }
}
function modelMatches(model, targets) {
    if (!targets || targets.length === 0)
        return true;
    const m = String(model ?? '').toLowerCase();
    return targets.some(target => {
        const t = target.toLowerCase().trim();
        if (!t)
            return false;
        return m.includes(t) || m === t || m.startsWith(t);
    });
}
function messageToOpenAI(message) {
    const role = message.role ?? 'user';
    const blocks = Array.isArray(message.content) ? message.content : [];
    if (!blocks.length)
        return { role, content: '' };
    const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('');
    const reasoning = blocks.filter((b) => b?.type === 'reasoning').map((b) => b.text ?? '').join('');
    const toolCalls = blocks.filter((b) => b?.type === 'tool-call').map((b) => ({
        id: b.id,
        type: 'function',
        function: { name: b.name, arguments: b.arguments ?? '' },
    }));
    const toolResults = blocks.filter((b) => b?.type === 'tool-result').map((b) => ({
        role: 'tool',
        tool_call_id: b.toolCallId,
        content: b.content?.filter((x) => x?.type === 'text').map((x) => x.text ?? '').join('') ?? '',
    }));
    if (role === 'assistant') {
        return {
            role,
            ...(text ? { content: text } : { content: '' }),
            ...(reasoning ? { reasoning_content: reasoning } : {}),
            ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        };
    }
    if (role === 'tool')
        return { role, content: text };
    if (toolResults.length)
        return toolResults[0];
    return { role, content: text };
}
function buildBody(options, toolChoiceNone) {
    const body = {
        model: options.model,
        messages: [
            ...(options.system ? [{ role: 'system', content: options.system }] : []),
            ...options.messages.map(messageToOpenAI),
        ],
        ...(options.tools?.length ? { tools: options.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) } : {}),
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
        ...(options.stop?.length ? { stop: options.stop } : {}),
        stream: true,
    };
    if (toolChoiceNone)
        body.tool_choice = 'none';
    return body;
}
function hasUsableContent(chunks) {
    let usable = false;
    for (const c of chunks) {
        if (c.type === 'text-delta' && c.text)
            usable = true;
        if (c.type === 'reasoning-delta' && c.text)
            usable = true;
        if (c.type === 'tool-call-delta' && (c.name || c.argumentsDelta || c.id))
            usable = true;
        if (c.type === 'block-end' && c.block?.type === 'tool-call')
            usable = true;
        if (c.type === 'block-end' && c.block?.type === 'text' && c.block.text)
            usable = true;
    }
    return usable;
}
function syntheticStream(text) {
    return (async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text };
        yield { type: 'block-end', index: 0, block: { type: 'text', text } };
        yield { type: 'finish', reason: { kind: 'stop' } };
    })();
}
function parseSse(buffer) {
    const out = [];
    for (const event of buffer.split(/\r?\n\r?\n/)) {
        const data = event.split(/\r?\n/).filter(x => x.startsWith('data:')).map(x => x.slice(5).trim()).join('\n');
        if (!data || data === '[DONE]')
            continue;
        try {
            out.push(JSON.parse(data));
        }
        catch { /* ignored: non-JSON SSE line */ }
    }
    return out;
}
function openAIToChunks(events) {
    const chunks = [];
    const blocks = new Map();
    let nextIndex = 0;
    let usage;
    for (const event of events) {
        if (event.usage)
            usage = {
                inputTokens: Number(event.usage.prompt_tokens ?? event.usage.input_tokens ?? 0),
                outputTokens: Number(event.usage.completion_tokens ?? event.usage.output_tokens ?? 0),
                ...(event.usage.total_tokens !== undefined ? { totalTokens: Number(event.usage.total_tokens) } : {}),
            };
        const choice = event.choices?.[0];
        if (!choice)
            continue;
        const delta = choice.delta ?? {};
        if (delta.content) {
            let b = [...blocks.entries()].find(([, x]) => x.type === 'text');
            if (!b) {
                const index = nextIndex++;
                blocks.set(index, { type: 'text', args: '', text: '' });
                chunks.push({ type: 'block-start', index, blockType: 'text' });
                b = [index, blocks.get(index)];
            }
            const str = String(delta.content);
            b[1].text = (b[1].text ?? '') + str;
            chunks.push({ type: 'text-delta', index: b[0], text: str });
        }
        if (delta.reasoning_content || delta.reasoning) {
            const value = String(delta.reasoning_content ?? delta.reasoning);
            let b = [...blocks.entries()].find(([, x]) => x.type === 'reasoning');
            if (!b) {
                const index = nextIndex++;
                blocks.set(index, { type: 'reasoning', args: '', text: '' });
                chunks.push({ type: 'block-start', index, blockType: 'reasoning' });
                b = [index, blocks.get(index)];
            }
            b[1].text = (b[1].text ?? '') + value;
            chunks.push({ type: 'reasoning-delta', index: b[0], text: value });
        }
        for (const tc of delta.tool_calls ?? []) {
            const index = typeof tc.index === 'number' ? tc.index : nextIndex;
            if (!blocks.has(index)) {
                blocks.set(index, { type: 'tool-call', id: tc.id, name: tc.function?.name, args: '' });
                nextIndex = Math.max(nextIndex, index + 1);
                chunks.push({ type: 'block-start', index, blockType: 'tool-call' });
            }
            const b = blocks.get(index);
            if (tc.id)
                b.id = tc.id;
            if (tc.function?.name)
                b.name = tc.function.name;
            const args = String(tc.function?.arguments ?? '');
            if (args) {
                b.args += args;
                chunks.push({ type: 'tool-call-delta', index, id: b.id ?? '', ...(b.name ? { name: b.name } : {}), argumentsDelta: args });
            }
        }
        if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'function_call') {
            // close tool blocks below
        }
    }
    for (const [index, b] of blocks) {
        if (b.type === 'text')
            chunks.push({ type: 'block-end', index, block: { type: 'text', text: b.text ?? '' } });
        else if (b.type === 'reasoning')
            chunks.push({ type: 'block-end', index, block: { type: 'reasoning', text: b.text ?? '' } });
        else
            chunks.push({ type: 'block-end', index, block: { type: 'tool-call', id: b.id ?? '', name: b.name ?? '', arguments: b.args } });
    }
    if (usage)
        chunks.push({ type: 'usage', usage });
    const hasTools = [...blocks.values()].some(x => x.type === 'tool-call');
    chunks.push({ type: 'finish', reason: { kind: hasTools ? 'tool-calls' : 'stop' } });
    return chunks;
}
async function resolveProviderEndpointAndKey(provider, config) {
    let baseURL = config.upstreamBaseUrl || 'http://127.0.0.1:3000/v1';
    let apiKey = config.apiKey || '';
    try {
        const fs = await import('node:fs/promises');
        const path = await import('node:path');
        const os = await import('node:os');
        const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
        const settingsPath = path.join(home, 'settings.yaml');
        const credsPath = path.join(home, '.credentials.yaml');
        let keyEnv = '';
        try {
            const sText = await fs.readFile(settingsPath, 'utf8');
            const pBlockMatch = sText.match(new RegExp('\\b' + provider + ':[\\s\\S]*?(?=\\n\\s{2,4}[\\w-]+:|$)', 'u'));
            if (pBlockMatch) {
                const block = pBlockMatch[0];
                const urlMatch = block.match(/baseURL:\s*([^\r\n]+)/);
                if (urlMatch && urlMatch[1])
                    baseURL = urlMatch[1].trim();
                const envMatch = block.match(/apiKeyEnv:\s*([^\r\n]+)/);
                if (envMatch && envMatch[1])
                    keyEnv = envMatch[1].trim();
            }
        }
        catch { }
        if (keyEnv && process.env[keyEnv]) {
            apiKey = process.env[keyEnv];
        }
        else if (keyEnv) {
            try {
                const cText = await fs.readFile(credsPath, 'utf8');
                const refMatch = cText.match(new RegExp('\\b' + keyEnv + ':\\s*([^\\r\\n]+)', 'u'));
                if (refMatch && refMatch[1])
                    apiKey = refMatch[1].trim();
            }
            catch { }
        }
        if (!apiKey) {
            try {
                const cText = await fs.readFile(credsPath, 'utf8');
                const fallbackMatch = cText.match(/\b(SUB2API_[^:\r\n]+|GEMINI_API_KEY):\s*([^\r\n]+)/);
                if (fallbackMatch && fallbackMatch[2])
                    apiKey = fallbackMatch[2].trim();
            }
            catch { }
        }
    }
    catch { }
    return { baseURL, apiKey };
}
class RecoveryAdapter extends LlmAdapter {
    ctx;
    config;
    log;
    getAgent;
    constructor(ctx, config, log, getAgent) {
        super();
        this.ctx = ctx;
        this.config = config;
        this.log = log;
        this.getAgent = getAgent;
    }
    providerInfo(provider) { return { id: provider, name: 'SUB2API / Antigravity Recovery' }; }
    async listModels(provider) {
        return this.config.targetModels.map(id => ({
            provider,
            id,
            name: id,
            description: 'Antigravity Empty Response Recovery Model',
            inputModalities: ['text'],
        }));
    }
    async resolveModel(provider, model) {
        return {
            provider,
            id: model,
            name: model,
            description: 'Antigravity Empty Response Recovery Model',
            inputModalities: ['text'],
            context: { contextWindow: 1000000 },
        };
    }
    resolveAgent(options) {
        if (this.getAgent) {
            const a = this.getAgent(options);
            if (a)
                return a;
        }
        if (options.agent)
            return options.agent;
        const agentService = getService(this.ctx, 'agent');
        if (agentService)
            return agentService;
        const agentsService = getService(this.ctx, 'agents');
        if (typeof agentsService?.currentInitiator === 'function') {
            const a = agentsService.currentInitiator();
            if (a)
                return a;
        }
        if (options.sessionId && typeof agentsService?.get === 'function') {
            return agentsService.get(options.sessionId);
        }
        return undefined;
    }
    async *stream(options) {
        const agent = this.resolveAgent(options);
        const syntheticArmed = Boolean(agent?.__agRecoverySynthetic || options.__agRecoverySynthetic);
        if (syntheticArmed) {
            if (agent)
                delete agent.__agRecoverySynthetic;
            delete options.__agRecoverySynthetic;
            if (this.config.syntheticFallback) {
                this.log('warn', 'recovery:synthetic-fallback', { model: options.model, sessionId: String(options.sessionId ?? '') });
                yield* syntheticStream(this.config.syntheticResponse);
                return;
            }
            throw new LlmError('Antigravity returned an empty response', EMPTY_RESPONSE);
        }
        const target = modelMatches(options.model, this.config.targetModels);
        if (!target) {
            yield* this.single(options, false, 'original');
            return;
        }
        this.log('info', 'request:start', { provider: options.provider, model: options.model, sessionId: String(options.sessionId ?? '') });
        for (let retry = 0; retry <= this.config.retryOriginal; retry++) {
            const strategy = retry === 0 ? 'original' : 'original-retry';
            const result = await this.collect(options, false, strategy);
            if (result.ok) {
                yield* result.chunks;
                return;
            }
            if (result.reason === 'aborted')
                throw new LlmError('request aborted', 'ABORTED');
        }
        if (this.config.enableToolChoiceNone && (options.tools?.length ?? 0) > 0) {
            this.log('warn', 'recovery:tool_choice:none', { model: options.model });
            const result = await this.collect(options, true, 'tool-choice-none');
            if (result.ok) {
                yield* result.chunks;
                return;
            }
        }
        if (this.config.compactAfterToolChoiceNone) {
            this.log('warn', 'recovery:compaction-required', { model: options.model, sessionId: String(options.sessionId ?? '') });
            throw new LlmError(COMPACTION_REQUIRED, COMPACTION_REQUIRED);
        }
        if (this.config.syntheticFallback)
            yield* syntheticStream(this.config.syntheticResponse);
        else
            throw new LlmError('Antigravity returned an empty response', EMPTY_RESPONSE);
    }
    async *single(options, toolChoiceNone, strategy) {
        const result = await this.collect(options, toolChoiceNone, strategy);
        if (!result.ok)
            throw new LlmError('Antigravity returned an empty response', EMPTY_RESPONSE);
        yield* result.chunks;
    }
    async collect(options, toolChoiceNone, strategy) {
        const body = buildBody(options, toolChoiceNone);
        this.log('debug', 'upstream:request', this.config.includeRequestBodyInDebugLog ? body : { strategy, model: options.model, toolChoice: toolChoiceNone ? 'none' : 'auto', messageCount: body.messages.length, toolCount: body.tools?.length ?? 0 });
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
        const onAbort = () => controller.abort();
        options.signal?.addEventListener('abort', onAbort, { once: true });
        try {
            const resolved = await resolveProviderEndpointAndKey(options.provider, this.config);
            const url = resolved.baseURL.replace(/\/$/, '') + '/chat/completions';
            const headers = { 'content-type': 'application/json', accept: 'text/event-stream' };
            if (resolved.apiKey)
                headers.authorization = `Bearer ${resolved.apiKey}`;
            const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
            const text = await response.text();
            const byteLength = new TextEncoder().encode(text).length;
            this.log('debug', 'upstream:response', { status: response.status, bytes: byteLength, strategy });
            if (!response.ok)
                throw new LlmError(`SUB2API HTTP ${response.status}: ${text.slice(0, 1000)}`, 'PROVIDER_HTTP_ERROR');
            const events = parseSse(text);
            const chunks = openAIToChunks(events);
            const usable = hasUsableContent(chunks);
            if (!usable) {
                this.log('warn', 'recovery:empty', { strategy, model: options.model, bytes: byteLength });
                return { ok: false, reason: 'empty' };
            }
            this.log('info', 'recovery:success', { strategy, model: options.model });
            return { ok: true, chunks };
        }
        catch (error) {
            if (controller.signal.aborted || options.signal?.aborted)
                return { ok: false, reason: 'aborted' };
            throw error;
        }
        finally {
            clearTimeout(timer);
            options.signal?.removeEventListener('abort', onAbort);
        }
    }
}
function getService(ctx, name) {
    if (ctx && typeof ctx.get === 'function') {
        try {
            return ctx.get(name);
        }
        catch {
            return undefined;
        }
    }
    return ctx?.[name];
}
function isOurFailure(failure, code) {
    return failure?.code === code || String(failure?.message ?? '').includes(code);
}
async function ensureProviderCardConfigured(ctx, provider, config, fileLog) {
    try {
        const fs = await import('node:fs/promises');
        const path = await import('node:path');
        const os = await import('node:os');
        const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
        const settingsPath = path.join(home, 'settings.yaml');
        let fileContent = '';
        try {
            fileContent = await fs.readFile(settingsPath, 'utf8');
        }
        catch {
            fileContent = '';
        }
        if (fileContent.includes(provider)) {
            return;
        }
        const eol = fileContent.includes('\r\n') ? '\r\n' : '\n';
        const defaultCard = [
            `    ${provider}:`,
            `      displayName: 反重力空响应恢复 (Antigravity Recovery)`,
            `      api: openai-completions`,
            `      baseURL: ${config.upstreamBaseUrl || 'http://127.0.0.1:3000/v1'}`,
            `      apiKeyEnv: ${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`,
            `      models:`,
            ...config.targetModels.map(m => `        - id: ${m}${eol}          name: ${m}`),
            ''
        ].join(eol);
        if (fileContent.includes('llm-pi-ai:')) {
            if (/\bproviders:\s*\r?\n/.test(fileContent)) {
                fileContent = fileContent.replace(/(\bproviders:\s*\r?\n)/, `$1${defaultCard}`);
            }
            else {
                fileContent = fileContent.replace(/(\bllm-pi-ai:\s*\r?\n)/, `$1  providers:${eol}${defaultCard}`);
            }
        }
        else {
            fileContent = (fileContent ? fileContent.trimEnd() + eol + eol : '') + [
                'llm-pi-ai:',
                '  providers:',
                defaultCard
            ].join(eol);
        }
        await fs.writeFile(settingsPath, fileContent, 'utf8');
        fileLog.write('info', 'Settings', 'Provider card configured in settings.yaml', { provider, settingsPath });
    }
    catch (err) {
        fileLog.write('warn', 'Settings', 'Failed to configure provider card', { error: String(err) });
    }
}
export function apply(ctx, config) {
    if (!config.enabled)
        return;
    const fileLogger = new FileLogger(config.logFilePath || getDefaultLogPath(), config.logLevel);
    fileLogger.write('info', 'PluginInit', 'Antigravity Empty Response Recovery v0.4.2 active', {
        interceptAllProviders: config.interceptAllProviders,
        targetModels: config.targetModels,
        providers: config.providers,
        retryWithNudge: config.retryWithNudge,
        enableToolChoiceNone: config.enableToolChoiceNone,
        syntheticFallback: config.syntheticFallback,
        logFile: config.logFilePath || getDefaultLogPath(),
    });
    const legacyLog = (level, message, data) => {
        fileLogger.write(level, 'LegacyAdapter', message, data);
    };
    const sessionAgents = new Map();
    const getAgent = (options) => {
        if (options.agent)
            return options.agent;
        const sid = String(options.sessionId ?? '');
        if (sid && sessionAgents.has(sid))
            return sessionAgents.get(sid);
        const agentsService = getService(ctx, 'agents');
        if (sid && typeof agentsService?.get === 'function')
            return agentsService.get(sid);
        if (typeof agentsService?.currentInitiator === 'function')
            return agentsService.currentInitiator();
        const agentService = getService(ctx, 'agent');
        if (agentService)
            return agentService;
        return undefined;
    };
    // ── Standalone adapter registration (only if explicitly enabled) ──
    if (config.registerStandaloneAdapter) {
        try {
            const adapter = new RecoveryAdapter(ctx, config, legacyLog, getAgent);
            ctx.llm.registerAdapter(config.providers, adapter);
            fileLogger.write('info', 'RegisterAdapter', 'Standalone recovery adapter registered', { providers: config.providers });
        }
        catch (err) {
            fileLogger.write('debug', 'RegisterAdapter', 'Standalone adapter registration skipped or already registered by host', { message: err?.message });
        }
    }
    // ── TIER 1: Universal llm/stream Waterfall Interceptor ────────────
    ctx.on('llm/stream', (options, next) => {
        // Prevent recursion during recovery retries
        if (options.__agRecoveryRetrying) {
            return next();
        }
        // Match model
        const matchesModel = modelMatches(options.model, config.targetModels);
        if (!matchesModel) {
            return next();
        }
        // Match provider (either all providers or explicitly listed)
        const matchesProvider = config.interceptAllProviders || config.providers.some(p => p.toLowerCase() === String(options.provider ?? '').toLowerCase());
        if (!matchesProvider) {
            return next();
        }
        fileLogger.write('debug', 'StreamIntercept', `Intercepting LLM stream`, {
            provider: options.provider,
            model: options.model,
            sessionId: options.sessionId,
            messageCount: options.messages?.length ?? 0,
            toolsCount: options.tools?.length ?? 0,
        });
        return (async function* () {
            const buffer = [];
            let streaming = false;
            let finishChunk = null;
            let usageInfo = null;
            let totalTextChars = 0;
            let totalToolCalls = 0;
            let totalReasoningChars = 0;
            try {
                const stream = next();
                for await (const chunk of stream) {
                    if (chunk.type === 'usage') {
                        usageInfo = chunk.usage;
                    }
                    if (streaming) {
                        // Content already confirmed: stream out in real time with 0 latency
                        if (chunk.type === 'text-delta' && chunk.text)
                            totalTextChars += chunk.text.length;
                        if (chunk.type === 'tool-call-delta' && (chunk.name || chunk.argumentsDelta || chunk.id))
                            totalToolCalls++;
                        if (chunk.type === 'reasoning-delta' && chunk.text)
                            totalReasoningChars += chunk.text.length;
                        if (chunk.type === 'finish')
                            finishChunk = chunk;
                        yield chunk;
                        continue;
                    }
                    // Check for first visible content
                    let isContentChunk = false;
                    if (chunk.type === 'text-delta' && chunk.text) {
                        isContentChunk = true;
                        totalTextChars += chunk.text.length;
                    }
                    if (chunk.type === 'tool-call-delta' && (chunk.name || chunk.argumentsDelta || chunk.id)) {
                        isContentChunk = true;
                        totalToolCalls++;
                    }
                    if (chunk.type === 'block-end') {
                        const b = chunk.block;
                        if (b?.type === 'text' && b.text) {
                            isContentChunk = true;
                            totalTextChars = Math.max(totalTextChars, b.text.length);
                        }
                        if (b?.type === 'tool-call') {
                            isContentChunk = true;
                            totalToolCalls++;
                        }
                    }
                    if (chunk.type === 'reasoning-delta' && chunk.text) {
                        totalReasoningChars += chunk.text.length;
                    }
                    if (chunk.type === 'finish') {
                        finishChunk = chunk;
                    }
                    buffer.push(chunk);
                    if (isContentChunk) {
                        // First content chunk detected! Flush buffer immediately and switch to real-time streaming
                        streaming = true;
                        for (const c of buffer)
                            yield c;
                        buffer.length = 0;
                    }
                }
            }
            catch (err) {
                fileLogger.write('error', 'StreamException', `Upstream stream threw error`, {
                    error: String(err?.message ?? err),
                    provider: options.provider,
                    model: options.model,
                });
                throw err;
            }
            if (streaming) {
                fileLogger.write('info', 'StreamSuccess', `Normal response streamed in real-time`, {
                    provider: options.provider,
                    model: options.model,
                    textChars: totalTextChars,
                    toolCalls: totalToolCalls,
                    reasoningChars: totalReasoningChars,
                    cacheRead: usageInfo?.cacheRead ?? usageInfo?.cachedTokens ?? 0,
                    inputTokens: usageInfo?.inputTokens,
                    outputTokens: usageInfo?.outputTokens,
                    finishKind: finishChunk?.reason?.kind,
                });
                return;
            }
            // If streaming never became true, check whether this stream ended with empty content
            const finishReason = finishChunk?.reason;
            const isErrorEmpty = finishReason?.kind === 'error' && (finishReason.failure?.code === EMPTY_RESPONSE ||
                String(finishReason.failure?.message ?? '').toLowerCase().includes('no content'));
            const isStopEmpty = finishReason?.kind === 'stop';
            const isEmpty = isErrorEmpty || isStopEmpty;
            if (!isEmpty) {
                for (const c of buffer)
                    yield c;
                return;
            }
            // EMPTY RESPONSE DETECTED!
            fileLogger.write('warn', 'EmptyDetected', `Upstream returned empty response with NO content!`, {
                provider: options.provider,
                model: options.model,
                sessionId: options.sessionId,
                reasoningChars: totalReasoningChars,
                isErrorEmpty,
                isStopEmpty,
                finishFailure: finishReason?.kind === 'error' ? finishReason.failure : undefined,
            });
            // ── Step 1: Nudge Retry ──────────────────────────────────────
            if (config.retryWithNudge) {
                fileLogger.write('info', 'NudgeRetry', `Attempting nudge retry with continuation prompt...`, {
                    nudgePrompt: config.nudgePrompt,
                });
                try {
                    let retryMessages = [];
                    const origMessages = options.messages || [];
                    if (origMessages.length > 0) {
                        const lastMsg = origMessages[origMessages.length - 1];
                        if (lastMsg && (lastMsg.role === 'user' || lastMsg.role === 'toolResult')) {
                            // Merge into existing user message so role alternation is preserved
                            // and upstream prefix caching (Gemini / Anthropic) is not disrupted by consecutive user messages!
                            const updatedLastMsg = { ...lastMsg };
                            if (Array.isArray(lastMsg.content)) {
                                updatedLastMsg.content = [
                                    ...lastMsg.content,
                                    { type: 'text', text: `\n\n${config.nudgePrompt}` },
                                ];
                            }
                            else if (typeof lastMsg.content === 'string') {
                                updatedLastMsg.content = [
                                    { type: 'text', text: `${lastMsg.content}\n\n${config.nudgePrompt}` },
                                ];
                            }
                            else {
                                updatedLastMsg.content = [{ type: 'text', text: config.nudgePrompt }];
                            }
                            retryMessages = [...origMessages.slice(0, -1), updatedLastMsg];
                        }
                        else {
                            retryMessages = [
                                ...origMessages,
                                {
                                    role: 'user',
                                    content: [{ type: 'text', text: config.nudgePrompt }],
                                },
                            ];
                        }
                    }
                    else {
                        retryMessages = [
                            {
                                role: 'user',
                                content: [{ type: 'text', text: config.nudgePrompt }],
                            },
                        ];
                    }
                    const retryOptions = {
                        ...options,
                        __agRecoveryRetrying: true,
                        messages: retryMessages,
                    };
                    const retryStream = ctx.llm.stream(retryOptions);
                    const retryChunks = [];
                    let retryHasContent = false;
                    let retryFinish = null;
                    for await (const c of retryStream) {
                        if (c.type === 'text-delta' && c.text)
                            retryHasContent = true;
                        if (c.type === 'tool-call-delta' && (c.name || c.argumentsDelta || c.id))
                            retryHasContent = true;
                        if (c.type === 'block-end') {
                            const b = c.block;
                            if ((b?.type === 'text' && b.text) || b?.type === 'tool-call')
                                retryHasContent = true;
                        }
                        if (c.type === 'finish')
                            retryFinish = c;
                        retryChunks.push(c);
                    }
                    if (retryHasContent && (retryFinish?.reason?.kind === 'stop' || retryFinish?.reason?.kind === 'tool-calls')) {
                        fileLogger.write('info', 'RecoverySuccess', `Nudge retry SUCCEEDED with content! Forwarding to agent.`, {
                            chunkCount: retryChunks.length,
                            finishReason: retryFinish?.reason?.kind,
                        });
                        for (const c of retryChunks)
                            yield c;
                        return;
                    }
                    fileLogger.write('warn', 'NudgeRetryFailed', `Nudge retry completed but still had no content.`);
                }
                catch (err) {
                    fileLogger.write('warn', 'NudgeRetryError', `Nudge retry error: ${err?.message ?? err}`);
                }
            }
            // ── Step 2: Tool-Choice None Retry (if tools were provided) ──
            if (config.enableToolChoiceNone && (options.tools?.length ?? 0) > 0) {
                fileLogger.write('info', 'NoToolsRetry', `Retrying with tools disabled to force text response...`);
                try {
                    const noToolsOptions = {
                        ...options,
                        __agRecoveryRetrying: true,
                        tools: undefined,
                    };
                    const noToolsStream = ctx.llm.stream(noToolsOptions);
                    const noToolsChunks = [];
                    let noToolsHasContent = false;
                    let noToolsFinish = null;
                    for await (const c of noToolsStream) {
                        if (c.type === 'text-delta' && c.text)
                            noToolsHasContent = true;
                        if (c.type === 'block-end' && c.block?.type === 'text' && c.block?.text)
                            noToolsHasContent = true;
                        if (c.type === 'finish')
                            noToolsFinish = c;
                        noToolsChunks.push(c);
                    }
                    if (noToolsHasContent && noToolsFinish?.reason?.kind === 'stop') {
                        fileLogger.write('info', 'RecoverySuccess', `No-tools retry SUCCEEDED! Forwarding to agent.`, {
                            chunkCount: noToolsChunks.length,
                        });
                        for (const c of noToolsChunks)
                            yield c;
                        return;
                    }
                    fileLogger.write('warn', 'NoToolsRetryFailed', `No-tools retry completed but still had no content.`);
                }
                catch (err) {
                    fileLogger.write('warn', 'NoToolsRetryError', `No-tools retry error: ${err?.message ?? err}`);
                }
            }
            // ── Step 3: Synthetic Fallback (Never crash the turn) ─────────
            if (config.syntheticFallback) {
                fileLogger.write('warn', 'SyntheticFallback', `Retries exhausted. Emitting synthetic response to prevent crash.`, {
                    syntheticResponse: config.syntheticResponse,
                });
                yield* syntheticStream(config.syntheticResponse);
                return;
            }
            // If synthetic fallback disabled, yield original chunks so caller handles error
            for (const c of buffer)
                yield c;
        })();
    });
    // ── TIER 2: agent/request-error High-Priority Hook ────────────────
    const states = new WeakMap();
    ctx.on('agent/request-error', async (payload, next) => {
        const isOurEmpty = payload.failure?.code === EMPTY_RESPONSE ||
            String(payload.failure?.message ?? '').toLowerCase().includes('no content') ||
            isOurFailure(payload.failure, COMPACTION_REQUIRED);
        if (!isOurEmpty || payload.signal?.aborted)
            return next();
        fileLogger.write('warn', 'RequestErrorHook', `agent/request-error received empty response`, {
            turn: payload.turn,
            step: payload.step,
            provider: payload.provider,
            failure: payload.failure,
        });
        const agent = payload.agent;
        const sid = String(agent?.id ?? agent?.session?.id ?? '');
        if (sid)
            sessionAgents.set(sid, agent);
        const previous = states.get(agent);
        const state = (previous && previous.turn === payload.turn) ? previous : {
            turn: payload.turn,
            originalRetries: 0,
            toolChoiceNoneTried: true,
            compactionRequested: false,
            compactionCount: 0,
            postCompactionRetries: 0,
        };
        states.set(agent, state);
        if (state.compactionCount >= 1) {
            if (config.syntheticFallback) {
                fileLogger.write('warn', 'Recovery', 'post-compaction-empty synthetic fallback', { model: agent?.options?.model });
                agent.__agRecoverySynthetic = true;
                return { kind: 'retry' };
            }
            fileLogger.write('warn', 'Recovery', 'post-compaction-empty terminal-empty-response', { model: agent?.options?.model });
            if (payload.failure && typeof payload.failure === 'object') {
                payload.failure.code = EMPTY_RESPONSE;
                payload.failure.message = 'Antigravity returned an empty response';
            }
            return next();
        }
        // Check compaction if context is large or requested
        const compactionService = getService(ctx, 'compaction');
        if (compactionService?.compactIfNeeded) {
            try {
                const before = agent?.session?.surface?.replaceGeneration;
                fileLogger.write('info', 'Compaction', `Triggering context compaction on empty response`, {
                    turn: payload.turn,
                    step: payload.step,
                });
                const result = await compactionService.compactIfNeeded({ session: agent?.session, options: { provider: agent?.options?.provider, model: agent?.options?.model } }, 'context-overflow', payload.signal);
                const after = agent?.session?.surface?.replaceGeneration;
                const progressed = result !== null || (typeof before === 'number' && typeof after === 'number' && after > before);
                fileLogger.write(progressed ? 'info' : 'warn', 'CompactionResult', `Compaction finished`, { progressed, before, after });
                if (progressed) {
                    state.compactionCount++;
                    return { kind: 'retry' };
                }
            }
            catch (error) {
                fileLogger.write('error', 'CompactionError', `Compaction failed: ${error?.message ?? error}`);
            }
        }
        return next();
    }, { prepend: true });
    ctx.on('agent/turn-stopping', ({ agent, turn }) => {
        if (agent)
            delete agent.__agRecoverySynthetic;
        const sid = String(agent?.id ?? agent?.session?.id ?? '');
        if (sid)
            sessionAgents.delete(sid);
        const state = states.get(agent);
        if (state?.turn === turn)
            states.delete(agent);
    });
    ctx.on('agent/disposed', ({ agent }) => {
        if (agent)
            delete agent.__agRecoverySynthetic;
        const sid = String(agent?.id ?? agent?.session?.id ?? '');
        if (sid)
            sessionAgents.delete(sid);
        states.delete(agent);
    });
}
export { EMPTY_RESPONSE, COMPACTION_REQUIRED, SYNTHETIC_REQUIRED, RecoveryAdapter, syntheticStream, FileLogger };
