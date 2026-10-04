import { SEED_LEDGER, SEED_ROWS } from './seed'
import type { EntryRow, LedgerRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'airport-ground-ops:entries'
// 保障班组领用清单（由客舱清洁作业派生）单独存一份，不混进模块表，避免被看板当成一个业务模块。
const LEDGER_KEY = 'airport-ground-ops:team-ledger'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 旧版本里「用水量/耗材领用」是演示字符串，也没有挂账快照；这里统一规整成数值并补齐快照，
// 保证退回扣减只可能发生在数字上，且老用户的存量数据也能正确回落。
function normalizeNumber(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0
}

function normalizeCabinRow(row: EntryRow): EntryRow {
  const status = String(row.status ?? '')
  const postedLike = status === '待质检' || status === '已完成'
  return {
    ...row,
    用水量: normalizeNumber(row['用水量']),
    耗材领用: normalizeNumber(row['耗材领用']),
    '已挂账耗材':
      typeof row['已挂账耗材'] === 'number'
        ? row['已挂账耗材']
        : postedLike
          ? normalizeNumber(row['耗材领用'])
          : 0,
    '已挂账用水':
      typeof row['已挂账用水'] === 'number'
        ? row['已挂账用水']
        : postedLike
          ? normalizeNumber(row['用水量'])
          : 0,
  }
}

function normalizeLedgerRow(row: LedgerRow): LedgerRow {
  return {
    ...row,
    耗材领用: normalizeNumber(row['耗材领用']),
    用水量: normalizeNumber(row['用水量']),
  }
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    // 新模块/新字段以种子为准，老数据里已有的模块保留用户改动。
    const merged = { ...fallback, ...parsed }
    if (Array.isArray(merged.cabin)) {
      merged.cabin = merged.cabin.map(normalizeCabinRow)
    }
    return merged
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

function readLedgerStorage(): LedgerRow[] {
  const fallback = clone(SEED_LEDGER)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(LEDGER_KEY)
  if (!raw) {
    window.localStorage.setItem(LEDGER_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as LedgerRow[]).map(normalizeLedgerRow) : clone(fallback)
  } catch {
    window.localStorage.setItem(LEDGER_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null
let ledgerCache: LedgerRow[] | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function listLedger(): LedgerRow[] {
  if (ledgerCache === null) {
    ledgerCache = readLedgerStorage()
  }
  return ledgerCache
}

function persist(): void {
  if (typeof window === 'undefined' || !window.localStorage) {
    return
  }
  // 一次退回涉及作业行与班组台账两份数据：同一次提交里只写一次盘，要么都生效要么都不生效。
  if (cache !== null) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cache))
  }
  if (ledgerCache !== null) {
    window.localStorage.setItem(LEDGER_KEY, JSON.stringify(ledgerCache))
  }
}

// 整体回落/落账用的事务口：作业表与台账在内存里改完后一起落盘，杜绝只改一半。
export function commitAll(entries: Record<string, EntryRow[]>, ledger: LedgerRow[]): void {
  cache = entries
  ledgerCache = ledger
  persist()
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  persist()
}

export function saveLedger(rows: LedgerRow[]): void {
  ledgerCache = rows
  persist()
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

// 客舱清洁与班组领用台账是同一份业务的两层数据，重置清洁作业时台账必须一起回到种子，
// 否则又会出现作业记录与台账对不上的老问题。
export function resetCabin(): EntryRow[] {
  const rows = clone(SEED_ROWS.cabin ?? [])
  commitAll({ ...allRows(), cabin: rows }, clone(SEED_LEDGER))
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

export function ledgerStorageKey(): string {
  return LEDGER_KEY
}
