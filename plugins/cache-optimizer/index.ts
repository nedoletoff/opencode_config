/**
 * agent-cache-optimizer — OpenCode V2 plugin
 *
 * Порт V1-плагина agent-cache-optimizer на API OpenCode 2.
 *
 * Назначение прежнее: переупорядочивать блоки системного промпта так, чтобы
 * стабильный контент шёл в начале, а динамический — в конце. Это повышает
 * переиспользование префиксного KV-кэша провайдера между запросами и сессиями.
 *
 * Соответствие хуков V1 → V2:
 *   experimental.chat.system.transform → ctx.session.hook("context") (event.system)
 *   chat.params                        → ctx.session.hook("context") (первичная регистрация scope)
 *   chat.message                       → ctx.session.hook("prompt") (запоминание scope)
 *   chat.headers                       → ctx.session.hook("model.request")
 *   event                              → ctx.event.subscribe()
 *
 * Чистые модули (core/heuristics/splitting/types) перенесены без изменений.
 */

import { Plugin } from "@opencode/plugin"
import { join } from "node:path"
import { homedir } from "node:os"
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import {
  emptyDB,
  updateDB,
  updateContentDB,
  extractWarmHashes,
  estimateSavings,
  hashContent,
  lookupContentScore,
} from "./core"
import { classify } from "./heuristics"
import { splitAll } from "./splitting"
import type { StabilityDB } from "./types"

const VERSION = "0.6.0-v2"

// ── Пути состояния ───────────────────────────────────────────────────

const STATE_DIR = join(
  process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
  "opencode",
  "agent-cache-optimizer",
)

interface ModelIdentity {
  id?: string
  modelID?: string
  providerID?: string
  name?: string
}

function scopePart(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : fallback
}

function modelScope(model: ModelIdentity | undefined, agent?: string): string {
  const provider = scopePart(model?.providerID, "unknown-provider")
  const modelID = scopePart(model?.id ?? model?.modelID ?? model?.name, "unknown-model")
  if (provider === "unknown-provider" && modelID === "unknown-model") return "default"
  const normalizedAgent = agent?.trim()
  return normalizedAgent ? `${provider}__${modelID}__${normalizedAgent}` : `${provider}__${modelID}`
}

function dbPath(scope: string): string {
  const safe = scope.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "default"
  return join(STATE_DIR, `stability-${safe}.json`)
}

function warmCachePath(): string {
  return join(STATE_DIR, "warm-cache.json")
}

function eventsPath(): string {
  return join(STATE_DIR, "events.jsonl")
}

function loadDB(scope: string): StabilityDB {
  try {
    const raw = readFileSync(dbPath(scope), "utf-8")
    const db = JSON.parse(raw) as StabilityDB
    if (db.contentObservations === undefined || db.contentObservations === null) {
      db.contentIndex = {}
      db.contentScores = {}
      db.contentObservations = 0
      saveDB(scope, db)
    }
    return db
  } catch {
    return emptyDB()
  }
}

function saveDB(scope: string, db: StabilityDB): void {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true })
    db.updated = Date.now()
    writeFileSync(dbPath(scope), JSON.stringify(db, null, 2))
  } catch (error) {
    logError(scope, "save_db", error)
  }
}

// ── Отслеживание scope сессии ───────────────────────────────────────

interface ScopeContext {
  scope: string
  familyScope: string
}

const sessionScopes = new Map<string, ScopeContext>()

function scopeContext(model: ModelIdentity | undefined, agent?: string): ScopeContext {
  const scope = modelScope(model, agent)
  const modelFamily = modelScope(model)
  return { scope, familyScope: modelFamily === "default" ? scope : modelFamily }
}

function rememberSessionScope(
  sessionID: string | undefined,
  model: ModelIdentity | undefined,
  agent?: string,
): string {
  const context = scopeContext(model, agent)
  if (sessionID) sessionScopes.set(sessionID, context)
  return context.scope
}

function scopeForSession(sessionID: string | undefined, model: ModelIdentity | undefined): string {
  if (sessionID) {
    const known = sessionScopes.get(sessionID)
    if (known) return known.scope
  }
  return scopeContext(model).scope
}

function familyScopeForSession(
  sessionID: string | undefined,
  model: ModelIdentity | undefined,
): string {
  if (sessionID) {
    const known = sessionScopes.get(sessionID)
    if (known) return known.familyScope
  }
  return scopeContext(model).familyScope
}

// ── Прогрев кэша ─────────────────────────────────────────────────────

interface WarmCacheStore {
  version: 2
  global: string[]
  scopes: Record<string, string[]>
}

interface WarmCacheMemory {
  global: Set<string>
  scopes: Map<string, Set<string>>
}

const warmCache: WarmCacheMemory = { global: new Set(), scopes: new Map() }
let warmHashesLoaded = false

function loadWarmCache(): WarmCacheMemory {
  if (warmHashesLoaded) return warmCache
  warmHashesLoaded = true
  try {
    const raw = readFileSync(warmCachePath(), "utf-8")
    const parsed = JSON.parse(raw) as string[] | WarmCacheStore
    if (Array.isArray(parsed)) {
      warmCache.global = new Set(parsed)
    } else {
      warmCache.global = new Set(parsed.global ?? [])
      for (const [scope, hashes] of Object.entries(parsed.scopes ?? {})) {
        warmCache.scopes.set(scope, new Set(hashes))
      }
    }
  } catch {
    /* пустой прогрев — норма */
  }
  return warmCache
}

function saveWarmCache(scope: string, db: StabilityDB): void {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true })
    warmCache.scopes.set(scope, extractWarmHashes(db))

    const counts = new Map<string, number>()
    for (const hashes of warmCache.scopes.values()) {
      for (const hash of hashes) counts.set(hash, (counts.get(hash) ?? 0) + 1)
    }
    warmCache.global = new Set(
      [...counts.entries()].filter(([, count]) => count >= 2).map(([hash]) => hash),
    )

    const store: WarmCacheStore = {
      version: 2,
      global: [...warmCache.global].sort(),
      scopes: Object.fromEntries(
        [...warmCache.scopes.entries()]
          .filter(([, hashes]) => hashes.size > 0)
          .map(([scopeName, hashes]) => [scopeName, [...hashes].sort()]),
      ),
    }
    writeFileSync(warmCachePath(), JSON.stringify(store, null, 2))
    eventLog("warm_cache_update", scope, {
      scopedHashCount: store.scopes[scope]?.length ?? 0,
      globalHashCount: store.global.length,
      scopeCount: Object.keys(store.scopes).length,
      observations: db.observations,
    })
  } catch (error) {
    logError(scope, "save_warm_cache", error)
  }
}

// ── Учёт экономии ────────────────────────────────────────────────────

function savingsPath(): string {
  return join(STATE_DIR, "savings.json")
}

interface SavingsData {
  totalStableBytes: number
  totalObservations: number
  estimatedSavingsUSD: number
  updated: number
}

function loadSavings(): SavingsData {
  try {
    return JSON.parse(readFileSync(savingsPath(), "utf-8")) as SavingsData
  } catch {
    return { totalStableBytes: 0, totalObservations: 0, estimatedSavingsUSD: 0, updated: 0 }
  }
}

function saveSavings(data: SavingsData): void {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true })
    data.updated = Date.now()
    writeFileSync(savingsPath(), JSON.stringify(data, null, 2))
  } catch (error) {
    logError("global", "save_savings", error)
  }
}

// ── Диагностика ──────────────────────────────────────────────────────

const MAX_DIAG_LINES = 1000
const MAX_DIAG_BYTES = 50 * 1024
const MAX_EVENT_LINES = 5000
const MAX_EVENT_BYTES = 512 * 1024
const DB_PRUNE_INTERVAL = 100
const DB_STALE_DAYS = 7

const loadedScopes = new Set<string>()

function diag(scope: string, msg: string): void {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true })
    const ts = new Date().toISOString()
    writeFileSync(join(STATE_DIR, "diag.log"), `[${ts}] [${scope}] ${msg}\n`, { flag: "a" })
  } catch {
    /* best-effort */
  }
}

function logError(scope: string, operation: string, error: unknown): void {
  eventLog("error", scope, {
    operation,
    message: error instanceof Error ? error.message : String(error),
  })
}

function eventLog(type: string, scope: string, data: Record<string, unknown> = {}): void {
  try {
    if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true })
    rotateLineLog(eventsPath(), MAX_EVENT_BYTES, MAX_EVENT_LINES)
    const event = { ts: new Date().toISOString(), version: VERSION, type, scope, ...data }
    writeFileSync(eventsPath(), `${JSON.stringify(event)}\n`, { flag: "a" })
  } catch {
    /* best-effort */
  }
}

function rotateLineLog(path: string, maxBytes: number, maxLines: number): void {
  try {
    if (!existsSync(path)) return
    const content = readFileSync(path, "utf-8")
    if (content.length < maxBytes) return
    const lines = content.split("\n").filter(Boolean)
    if (lines.length <= maxLines) return
    writeFileSync(path, lines.slice(-maxLines).join("\n") + "\n")
  } catch {
    /* best-effort */
  }
}

function rotateDiagLog(): void {
  rotateLineLog(join(STATE_DIR, "diag.log"), MAX_DIAG_BYTES, MAX_DIAG_LINES)
}

function pruneStaleHashes(db: StabilityDB): void {
  const now = Date.now()
  const staleMs = DB_STALE_DAYS * 24 * 60 * 60 * 1000
  for (const [hash, fp] of Object.entries(db.contentIndex)) {
    if (now - fp.lastSeen > staleMs && fp.count <= 2) {
      delete db.contentIndex[hash]
      delete db.contentScores[hash]
    }
  }
  for (const fps of Object.values(db.positions)) {
    for (let i = fps.length - 1; i >= 0; i--) {
      const fp = fps[i]!
      if (now - fp.lastSeen > staleMs && fp.count <= 2) {
        delete db.scores[fp.hash]
        fps.splice(i, 1)
      }
    }
  }
}

// ── Ранжирование стабильного префикса ───────────────────────────────

interface WarmHashMembership {
  global: Set<string>
  scoped: Set<string>
  family: Set<string>
}

interface StableRanking {
  sharedStable: string[]
  scopedStable: string[]
  coldStable: string[]
  dynamic: string[]
}

function classificationWarmHashes(membership: WarmHashMembership): Set<string> {
  const hashes = new Set<string>(membership.global)
  for (const hash of membership.scoped) hashes.add(hash)
  return hashes
}

function warmMembershipForScope(scope: string, familyDB: StabilityDB): WarmHashMembership {
  const cache = loadWarmCache()
  return {
    global: cache.global,
    scoped: cache.scopes.get(scope) ?? new Set(),
    family: extractWarmHashes(familyDB),
  }
}

function hasStableContentScore(db: StabilityDB, hash: string): boolean {
  const score = lookupContentScore(db, hash)
  return db.contentObservations >= 2 && score !== null && score >= 0.7
}

function rankStableBlocks(
  stableBlocks: string[],
  dynamicBlocks: string[],
  scopeDB: StabilityDB,
  familyDB: StabilityDB,
  warmMembership: WarmHashMembership,
): StableRanking {
  const ranking: StableRanking = {
    sharedStable: [],
    scopedStable: [],
    coldStable: [],
    dynamic: dynamicBlocks,
  }

  for (const block of stableBlocks) {
    const hash = hashContent(block)
    if (
      warmMembership.global.has(hash) ||
      warmMembership.family.has(hash) ||
      hasStableContentScore(familyDB, hash)
    ) {
      ranking.sharedStable.push(block)
      continue
    }
    if (warmMembership.scoped.has(hash) || hasStableContentScore(scopeDB, hash)) {
      ranking.scopedStable.push(block)
      continue
    }
    ranking.coldStable.push(block)
  }

  return ranking
}

function hashID(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined
  return hashContent(value)
}

// ── Плагин ───────────────────────────────────────────────────────────

/** Блок системного промпта в V2 — это объект { type: "text", text, cache?, metadata? }. */
interface SystemPart {
  type: "text"
  text: string
  cache?: unknown
  metadata?: Record<string, unknown>
}

export default Plugin.define({
  id: "agent-cache-optimizer",
  async setup(ctx) {
    loadWarmCache()

    // ── Основной хук: переупорядочивание системного промпта ────────
    //
    // V1 experimental.chat.system.transform принимал output.system как строки.
    // В V2 event.system — массив SystemPart. Мы разбиваем и ранжируем текст,
    // но сохраняем исходные прочие поля (cache, metadata) для каждого блока.
    await ctx.session.hook("context", (event) => {
      const parts = event.system ?? []
      if (parts.length === 0) return

      const scope = scopeForSession(event.sessionID, event.model)
      const entries = parts.map((part) => ({ part, text: part.text }))

      // Разбиение и классификация работают со строками.
      const splitEntries = entries.flatMap((entry) =>
        splitAll([entry.text]).map((text) => ({ ...entry, text })),
      )
      if (splitEntries.length <= 1) {
        eventLog("transform_seen", scope, {
          sessionHash: hashID(event.sessionID),
          rawBlockCount: parts.length,
          splitBlockCount: splitEntries.length,
          status: "skipped",
          reason: "insufficient_system_blocks",
        })
        return
      }

      const family = familyScopeForSession(event.sessionID, event.model)
      const db = loadDB(scope)
      const familyDB = family === scope ? db : loadDB(family)
      const warmMembership = warmMembershipForScope(scope, familyDB)

      const texts = splitEntries.map((entry) => entry.text)
      const classified = classify(texts, db, {
        splitThreshold: Number.MAX_SAFE_INTEGER,
        warmHashes: classificationWarmHashes(warmMembership),
      })

      const ranked = rankStableBlocks(
        classified.stable,
        [...classified.unknown, ...classified.dynamic],
        db,
        familyDB,
        warmMembership,
      )

      const textToEntry = new Map<string, { part: SystemPart }>()
      for (const entry of splitEntries) {
        if (!textToEntry.has(entry.text)) textToEntry.set(entry.text, { part: entry.part })
      }

      const orderedTexts = [
        ...ranked.sharedStable,
        ...ranked.scopedStable,
        ...ranked.coldStable,
        ...ranked.dynamic,
      ]

      const reordered: SystemPart[] = []
      for (const text of orderedTexts) {
        const source = textToEntry.get(text)
        if (!source) continue
        // Сохраняем исходные поля блока; меняем только текст, если он был разбит.
        reordered.push(
          source.part.text === text
            ? source.part
            : { ...source.part, text },
        )
      }
      if (reordered.length === 0) return
      event.system = reordered

      // Персистентность: позиционная и контентно-адресуемая.
      const orderedStrings = reordered.map((part) => part.text)
      updateDB(db, orderedStrings)
      updateContentDB(db, orderedStrings)
      if (family !== scope) {
        updateDB(familyDB, orderedStrings)
        updateContentDB(familyDB, orderedStrings)
      }

      if (db.observations % DB_PRUNE_INTERVAL === 0) pruneStaleHashes(db)
      if (family !== scope && familyDB.observations % DB_PRUNE_INTERVAL === 0) {
        pruneStaleHashes(familyDB)
      }

      saveDB(scope, db)
      if (family !== scope) saveDB(family, familyDB)
      rotateDiagLog()

      if (db.observations % 10 === 0) saveWarmCache(scope, db)

      const stableBytes = classified.stable.reduce((sum, block) => sum + block.length, 0)
      const savings = loadSavings()
      savings.totalStableBytes += stableBytes
      savings.totalObservations++
      savings.estimatedSavingsUSD = estimateSavings(savings.totalStableBytes, 1)
      saveSavings(savings)

      const sharedPrefixBytes = ranked.sharedStable.reduce((sum, block) => sum + block.length, 0)
      const estCallSaving = estimateSavings(stableBytes, 1)

      diag(
        scope,
        `S:${classified.stable.length} U:${classified.unknown.length} ` +
          `D:${classified.dynamic.length} T:${reordered.length} ` +
          `SH:${ranked.sharedStable.length} SC:${ranked.scopedStable.length} ` +
          `CS:${ranked.coldStable.length} obs:${db.observations} ` +
          `stableKB:${(stableBytes / 1024).toFixed(1)} ` +
          `sharedKB:${(sharedPrefixBytes / 1024).toFixed(1)} ` +
          `saved:$${estCallSaving.toFixed(6)} total:$${savings.estimatedSavingsUSD.toFixed(4)}`,
      )
      eventLog("transform", scope, {
        sessionHash: hashID(event.sessionID),
        family,
        counts: {
          stable: classified.stable.length,
          unknown: classified.unknown.length,
          dynamic: classified.dynamic.length,
          total: reordered.length,
        },
        ranking: {
          sharedStable: ranked.sharedStable.length,
          scopedStable: ranked.scopedStable.length,
          coldStable: ranked.coldStable.length,
          dynamic: ranked.dynamic.length,
          sharedPrefixBytes,
        },
        stableBytes,
        estimatedCallSavingsUSD: estCallSaving,
        totalEstimatedSavingsUSD: savings.estimatedSavingsUSD,
        observations: db.observations,
      })
    })

    // ── Диагностика загрузки: запоминаем scope сессии ─────────────
    //
    // V2-хук "prompt" не несёт модель (разрешение модели происходит позже
    // admission), поэтому идентичность сессии регистрируется здесь без модели,
    // а точный scope уточняется в хуке "context", где model доступна.
    await ctx.session.hook("prompt", (event) => {
      const model = undefined as ModelIdentity | undefined
      const scope = rememberSessionScope(event.sessionID, model)
      if (!loadedScopes.has(scope)) {
        loadedScopes.add(scope)
        const warmCount = (() => {
          const cache = loadWarmCache()
          const merged = new Set<string>(cache.global)
          for (const hash of cache.scopes.get(scope) ?? []) merged.add(hash)
          return merged.size
        })()
        diag(
          scope,
          `v${VERSION} loaded provider=${model?.providerID ?? "?"} model=${model?.id ?? "?"} warm=${warmCount}`,
        )
        eventLog("loaded", scope, {
          sessionHash: hashID(event.sessionID),
          provider: model?.providerID ?? "unknown-provider",
          model: model?.id ?? "unknown-model",
          warmCount,
        })
      }
    })

    // ── Заголовки провайдера для кэша ─────────────────────────────
    await ctx.session.hook("model.request", (event) => {
      const providerID = event.model?.providerID ?? ""
      if (providerID.toLowerCase().includes("anthropic")) {
        if (!event.headers["anthropic-beta"]) {
          event.headers["anthropic-beta"] = "prompt-caching-2024-07-31"
        }
      }
    })
  },
})
