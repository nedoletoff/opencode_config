/**
 * dotenv — OpenCode V2 plugin
 *
 * Порт V1-плагина @tianhuil/opencode-dotenv на API OpenCode 2.
 *
 * V1 использовал хук `shell.env`, чтобы подмешивать переменные из `.env`
 * в окружение shell-команд. В V2 этому соответствует
 * `ctx.shell.hook("create.before", ...)`: событие содержит `cwd` и `env`,
 * которые можно дописать до запуска команды.
 *
 * Порядок загрузки файлов (как в V1):
 *   .env.<NODE_ENV>.local → .env.<NODE_ENV> → .env.local → .env
 * Существующие переменные окружения не перезаписываются.
 */

import { Plugin } from "@opencode/plugin"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

export interface LoadDotEnvOptions {
  /** Окружение для выбора файла `.env.<nodeEnv>`. По умолчанию NODE_ENV или "development". */
  nodeEnv?: string
  /** Перезаписывать уже установленные переменные значениями из файлов. */
  overload?: boolean
}

/** Разбор содержимого `.env`: KEY=VALUE, поддержка кавычек и комментариев. */
function parseEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0 || line.startsWith("#")) continue

    // Поддержка префикса `export KEY=VALUE`.
    const withoutExport = line.startsWith("export ") ? line.slice("export ".length).trim() : line
    const eq = withoutExport.indexOf("=")
    if (eq <= 0) continue

    const key = withoutExport.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue

    let value = withoutExport.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    } else {
      // Убираем незакавыченный inline-комментарий.
      const hash = value.indexOf(" #")
      if (hash >= 0) value = value.slice(0, hash).trim()
    }
    // Разворачиваем переносы строк внутри значения.
    result[key] = value.replace(/\\n/g, "\n")
  }
  return result
}

/** Порядок файлов от наивысшего приоритета к низшему. */
function envFileOrder(basePath: string, nodeEnv: string): string[] {
  return [
    join(basePath, `.env.${nodeEnv}.local`),
    join(basePath, `.env.${nodeEnv}`),
    join(basePath, ".env.local"),
    join(basePath, ".env"),
  ]
}

async function readEnvFile(file: string): Promise<Record<string, string> | undefined> {
  try {
    return parseEnv(await readFile(file, "utf-8"))
  } catch {
    return undefined
  }
}

/**
 * Загружает переменные из набора `.env`-файлов.
 * При `overload === false` не перезаписывает уже собранные значения.
 */
export async function loadDotEnvFiles(
  basePath: string,
  options: LoadDotEnvOptions = {},
): Promise<Record<string, string>> {
  const nodeEnv = options.nodeEnv || process.env.NODE_ENV || "development"
  const files = envFileOrder(basePath, nodeEnv)
  const processEnv: Record<string, string> = {}

  for (const file of files) {
    const parsed = await readEnvFile(file)
    if (!parsed) continue
    for (const [key, value] of Object.entries(parsed)) {
      if (!(key in processEnv)) processEnv[key] = value
    }
  }

  if (options.overload) {
    // Низкоприоритетные файлы перетирают высокоприоритетные.
    const overloadedEnv: Record<string, string> = {}
    for (const file of [...files].reverse()) {
      const parsed = await readEnvFile(file)
      if (!parsed) continue
      for (const [key, value] of Object.entries(parsed)) overloadedEnv[key] = value
    }
    for (const [key, value] of Object.entries(overloadedEnv)) processEnv[key] = value
  }

  return processEnv
}

export default Plugin.define({
  id: "@tianhuil/opencode-dotenv",
  async setup(ctx) {
    const nodeEnv = (ctx.options.nodeEnv as string | undefined) || process.env.NODE_ENV || "development"
    const overload = ctx.options.overload === true

    ctx.shell.hook("create.before", async (event) => {
      const loaded = await loadDotEnvFiles(event.cwd || ctx.location.directory, { nodeEnv, overload })
      for (const [key, value] of Object.entries(loaded)) {
        // Как в V1: не перетираем то, что уже есть в окружении команды.
        if (!(key in event.env)) event.env[key] = value
      }
      if (!("NODE_ENV" in event.env)) event.env.NODE_ENV = nodeEnv
    })
  },
})
