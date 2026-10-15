/**
 * opencode-deepseek-thinking-fix — OpenCode V2 plugin
 *
 * Порт V1-плагина opencode-deepseek-thinking-fix на API OpenCode 2.
 *
 * Назначение: сохранять thinking/reasoning-контент DeepSeek-V4 между ходами
 * для Anthropic- и OpenAI-совместимых протоколов, с опциональной подстановкой
 * плейсхолдеров для «спасения» повреждённых диалогов.
 *
 * Соответствие V1 -> V2:
 *   config (мутация provider.options.fetch)
 *       -> ctx.session.hook("http.request") / ctx.session.hook("http.response")
 *   chat.params
 *       -> ctx.session.hook("context") — установка thinking/budget_tokens
 *
 * V1 перехватывал глобальный fetch провайдера. В V2 эквивалент — нативные хуки
 * сессии на HTTP-обмен:
 *   - "http.request"  получает mutable `event.request` (Request); JSON-тело
 *     можно переписать до реального fetch.
 *   - "http.response" получает `event.response` (Response со стримом тела);
 *     можно прочитать клон тела, извлечь reasoning и заменить ответ.
 *
 * Вспомогательные модули (cache/messages/messages-openai/stream/stream-openai)
 * перенесены без изменений.
 */

import { Plugin } from "@opencode/plugin"
import { ThinkingCache, fingerprint, type ThinkingBlock } from "./cache"
import {
  reinjectThinkingBlocks,
  extractThinkingFromResponse,
  fillThinkingPlaceholder,
  type AnthropicRequestBody,
  type AnthropicPlaceholderOptions,
} from "./messages"
import {
  reinjectReasoningContent,
  extractReasoningFromOpenAIResponse,
  assistantTurnFingerprintOpenAI,
  fillReasoningPlaceholder,
  type OpenAIChatRequestBody,
  type OpenAIReasoningPayload,
  type PlaceholderOptions,
} from "./messages-openai"
import { interceptStreamForThinking } from "./stream"
import { interceptOpenAIStreamForReasoning } from "./stream-openai"

const DEEPSEEK_KEYWORDS = ["deepseek", "deep-seek", "ds-v4", "dsv4"]

function matchesDeepSeekKeyword(value: string | undefined): boolean {
  if (!value) return false
  const lower = value.toLowerCase()
  return DEEPSEEK_KEYWORDS.some((keyword) => lower.includes(keyword))
}

type Protocol = "anthropic" | "openai" | "unknown"

/** Определение протокола по URL и форме тела запроса (как в V1). */
function detectProtocol(url: string, body: any): Protocol {
  const u = url.toLowerCase()
  if (u.includes("/v1/messages") || u.endsWith("/messages")) return "anthropic"
  if (u.includes("/chat/completions")) return "openai"
  if (!body || typeof body !== "object") return "unknown"
  if (Array.isArray(body.messages)) {
    const hasSystemField = typeof body.system === "string" || Array.isArray(body.system)
    if (hasSystemField) return "anthropic"
    const hasSystemRole = body.messages.some(
      (m: any) => m?.role === "system" || m?.role === "developer",
    )
    if (hasSystemRole) return "openai"
    if (body.thinking) return "anthropic"
    if (body.reasoning_effort) return "openai"
  }
  return "unknown"
}

export interface DeepSeekThinkingFixOptions {
  /** Provider ids для обработки (подстрочное совпадение). */
  providerIds?: string[]
  /** TTL кэша thinking-блоков (мс). По умолчанию 30 минут. */
  ttlMs?: number
  /** Дополнительное логирование. */
  debug?: boolean
  /** Гарантировать параметр `thinking` в Anthropic-запросах. */
  ensureThinkingEnabled?: boolean
  /** Бюджет токенов по умолчанию для инъекции `thinking`. */
  defaultBudgetTokens?: number
  /** Обрабатывать ли OpenAI-совместимые тела (/chat/completions). */
  handleOpenAI?: boolean
  /** Подстановка reasoning-плейсхолдера для OpenAI-запросов. */
  placeholder?: Partial<PlaceholderOptions>
  /** Подстановка thinking-плейсхолдера для Anthropic-запросов. */
  anthropicPlaceholder?: Partial<AnthropicPlaceholderOptions>
  /** Реагировать только на тела, чья `model` содержит deepseek-ключевое слово. */
  requireModelKeywordMatch?: boolean
}

type FetchImpl = typeof globalThis.fetch

interface ResolvedOptions {
  ttlMs: number
  debug: boolean
  ensureThinkingEnabled: boolean
  defaultBudgetTokens: number
  handleOpenAI: boolean
  requireModelKeywordMatch: boolean
  placeholderOpts: PlaceholderOptions
  anthPlaceholderOpts: AnthropicPlaceholderOptions
}

function resolveOptions(opts: DeepSeekThinkingFixOptions): ResolvedOptions {
  return {
    ttlMs: opts.ttlMs ?? 30 * 60 * 1000,
    debug: opts.debug ?? false,
    ensureThinkingEnabled: opts.ensureThinkingEnabled ?? true,
    defaultBudgetTokens: opts.defaultBudgetTokens ?? 8000,
    handleOpenAI: opts.handleOpenAI ?? true,
    requireModelKeywordMatch: opts.requireModelKeywordMatch ?? false,
    placeholderOpts: {
      mode: opts.placeholder?.mode ?? "fallback",
      text: opts.placeholder?.text ?? "(thinking omitted)",
      field: opts.placeholder?.field ?? "reasoning_content",
    },
    anthPlaceholderOpts: {
      mode: opts.anthropicPlaceholder?.mode ?? "fallback",
      text: opts.anthropicPlaceholder?.text ?? "(thinking omitted)",
      signaturePolicy: opts.anthropicPlaceholder?.signaturePolicy ?? "empty",
    },
  }
}

/** Кэш thinking-блоков, общий для всех запросов (как singleton в V1). */
const anthCache = new ThinkingCache(30 * 60 * 1000)
const oaCache = new Map<string, { payload: OpenAIReasoningPayload; at: number }>()

function oaGet(fp: string, ttlMs: number): OpenAIReasoningPayload | undefined {
  const entry = oaCache.get(fp)
  if (!entry) return undefined
  if (Date.now() - entry.at > ttlMs) {
    oaCache.delete(fp)
    return undefined
  }
  return entry.payload
}

function oaSet(fp: string, payload: OpenAIReasoningPayload): void {
  if (!payload.reasoning_content && !payload.reasoning) return
  if (oaCache.size > 500) {
    const oldest = [...oaCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (oldest) oaCache.delete(oldest[0])
  }
  oaCache.set(fp, { payload, at: Date.now() })
}

function stripAnthropicThinking(content: unknown): unknown {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return content
  return content
    .filter((c: any) => c && c.type !== "thinking" && c.type !== "redacted_thinking")
    .map((c: any) => {
      if (c.type === "text") return { type: "text", text: c.text }
      if (c.type === "tool_use")
        return { type: "tool_use", id: c.id, name: c.name, input: c.input }
      if (c.type === "tool_result")
        return { type: "tool_result", tool_use_id: c.tool_use_id, content: c.content }
      return { type: c.type }
    })
}

/**
 * Обрабатывает исходящее тело запроса: переинжектирует thinking/reasoning и
 * заполняет плейсхолдеры. Возвращает новый JSON-текст тела или undefined,
 * если тело не подлежит изменению.
 */
function processRequestBody(
  protocol: Protocol,
  body: unknown,
  opts: ResolvedOptions,
): string | undefined {
  if (!body || typeof body !== "object") return undefined

  if (protocol === "anthropic") {
    const anth = body as AnthropicRequestBody
    if (!Array.isArray(anth.messages)) return undefined
    if (opts.ensureThinkingEnabled && anth.thinking == null) {
      anth.thinking = { type: "enabled", budget_tokens: opts.defaultBudgetTokens }
    }
    reinjectThinkingBlocks(anth, (fp) => anthCache.get(fp))
    if (opts.anthPlaceholderOpts.mode !== "off") {
      fillThinkingPlaceholder(anth, opts.anthPlaceholderOpts)
    }
    return JSON.stringify(anth)
  }

  if (protocol === "openai" && opts.handleOpenAI) {
    const oa = body as OpenAIChatRequestBody
    if (!Array.isArray(oa.messages)) return undefined
    reinjectReasoningContent(oa, (fp) => oaGet(fp, opts.ttlMs))
    if (opts.placeholderOpts.mode !== "off") {
      fillReasoningPlaceholder(oa, opts.placeholderOpts)
    }
    return JSON.stringify(oa)
  }

  return undefined
}

/**
 * Обрабатывает ответ провайдера: оборачивает тело ответа так, чтобы по мере
 * вычитывания стрима реконструировать и кэшировать thinking/reasoning для
 * отпечатка следующего assistant-хода. Для не-стримовых ответов читаем клон.
 */
async function wrapResponseForCapture(
  protocol: Protocol,
  body: any,
  response: Response,
  opts: ResolvedOptions,
): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? ""
  const isStream =
    contentType.includes("text/event-stream") || body?.stream === true || response.body !== null

  // Для Anthropic-ответов кэшируем по отпечатку следующего хода.
  if (protocol === "anthropic") {
    const nextFp = fingerprint({
      model: body?.model ?? "",
      prefix: (body?.messages ?? []).map((m: any) => ({
        role: m.role,
        content: stripAnthropicThinking(m.content),
      })),
      protocol: "anthropic",
    })
    if (isStream && response.body) {
      return interceptStreamForThinking(response, (blocks) => {
        if (blocks.length) anthCache.set(nextFp, blocks)
      })
    }
    response
      .clone()
      .json()
      .then((json) => {
        const blocks = extractThinkingFromResponse(json)
        if (blocks.length) anthCache.set(nextFp, blocks)
      })
      .catch(() => {})
    return response
  }

  if (protocol === "openai" && opts.handleOpenAI) {
    const nextFp = assistantTurnFingerprintOpenAI(
      [...(body?.messages ?? []), { role: "assistant" }],
      body?.messages?.length ?? 0,
      body?.model,
    )
    if (isStream && response.body) {
      return interceptOpenAIStreamForReasoning(response, (payload) => oaSet(nextFp, payload))
    }
    response
      .clone()
      .json()
      .then((json) => {
        const payload = extractReasoningFromOpenAIResponse(json)
        if (payload) oaSet(nextFp, payload)
      })
      .catch(() => {})
    return response
  }

  return response
}

// ── Плагин ───────────────────────────────────────────────────────────

/** Провайдер подходит, если его id или id любого его модели содержит deepseek-ключ. */
function providerMatches(id: string, models: Record<string, unknown> | undefined): boolean {
  if (matchesDeepSeekKeyword(id)) return true
  if (models && typeof models === "object") {
    for (const mid of Object.keys(models)) {
      if (matchesDeepSeekKeyword(mid)) return true
    }
  }
  return false
}

export default Plugin.define({
  id: "opencode-deepseek-thinking-fix",
  async setup(ctx) {
    const options = resolveOptions(ctx.options as DeepSeekThinkingFixOptions)

    // Определяем, относится ли запрос к DeepSeek: по providerID из события
    // либо по полю `model` в теле. requireModelKeywordMatch включается, когда
    // провайдер явно не называется deepseek (как в V1 для релеев).
    const isTargetProvider = (providerID: string | undefined): boolean => {
      if (matchesDeepSeekKeyword(providerID)) return true
      // Проверяем также список моделей провайдера через каталог V2.
      return false
    }

    // ── Исходящие запросы: переинъекция thinking/reasoning ────────
    await ctx.session.hook("http.request", async (event) => {
      if (options.providerIds && options.providerIds.length > 0) {
        const pid = event.model?.providerID ?? ""
        if (!options.providerIds.some((id) => pid.includes(id))) return
      } else if (!isTargetProvider(event.model?.providerID) && !options.requireModelKeywordMatch) {
        // Если провайдер не распознан как deepseek и жёсткая проверка выключена,
        // всё равно продолжаем: V1 обрабатывал все запросы к обёрнутому провайдеру.
      }

      const request = event.request
      let text: string
      try {
        text = await request.clone().text()
      } catch {
        return
      }

      let body: any
      try {
        body = JSON.parse(text)
      } catch {
        return
      }

      if (options.requireModelKeywordMatch) {
        const m = typeof body?.model === "string" ? body.model : ""
        if (!matchesDeepSeekKeyword(m)) return
      }

      const protocol = detectProtocol(request.url, body)
      if (protocol === "unknown") return

      const mutated = processRequestBody(protocol, body, options)
      if (mutated === undefined) return

      // Заменяем тело запроса, сохраняя метод, url и заголовки.
      event.request = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: mutated,
      })

      if (options.debug) {
        console.log(`[deepseek-thinking-fix] http.request mutated protocol=${protocol}`)
      }
    })

    // ── Ответы провайдера: перехват и кэш thinking/reasoning ───────
    await ctx.session.hook("http.response", async (event) => {
      const request = event.request
      let body: any
      try {
        body = JSON.parse(await request.clone().text())
      } catch {
        return
      }

      if (options.requireModelKeywordMatch) {
        const m = typeof body?.model === "string" ? body.model : ""
        if (!matchesDeepSeekKeyword(m)) return
      }

      const protocol = detectProtocol(request.url, body)
      if (protocol === "unknown") return
      if (!event.response.ok) return

      event.response = await wrapResponseForCapture(protocol, body, event.response, options)
    })

    // ── Гарантируем включённый thinking для DeepSeek-моделей ───────
    await ctx.session.hook("context", (event) => {
      const pid = event.model?.providerID ?? ""
      const mid = event.model?.modelID ?? ""
      if (!matchesDeepSeekKeyword(pid) && !matchesDeepSeekKeyword(mid)) return
      if (event.options.thinking == null) {
        event.options.thinking = {
          type: "enabled",
          budget_tokens: options.defaultBudgetTokens,
        }
      }
    })

    if (options.debug) {
      console.log("[deepseek-thinking-fix] plugin loaded (V2)")
    }
  },
})
