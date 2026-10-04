import { MODULE_BY_KEY } from '@/data/modules'
import {
  allRows,
  commitAll,
  resetCabin,
  resetRows,
  saveLedger,
  saveRows,
} from '@/data/local-store'
import type {
  ActionResult,
  EntryRow,
  LedgerResult,
  LedgerRow,
  ModuleMeta,
  OverviewResult,
  PageResult,
  TeamLedgerStat,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '退回', '停用', '忽略', '下线', '回滚']

const CABIN_KEY = 'cabin'
const LEDGER_POSTED = '挂账'
const LEDGER_RETURNED = '已退回'

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRowsSafe(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

function listRowsSafe(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

function isNegative(action: string): boolean {
  return NEGATIVE_ACTIONS.some((verb) => action.includes(verb))
}

function todayText(): string {
  return new Date().toISOString().slice(0, 10)
}

// 以清洁作业记录为唯一事实源，重算某一条作业对应的台账行。
// 待质检/已完成 = 挂账（值取提交质检时落在作业行上的挂账快照）；
// 待清洁/清洁中 = 已退回且数值清零（统计口径不再计入），保留记录便于追溯。
function ledgerFromJob(row: EntryRow, id: number): LedgerRow {
  const status = String(row.status)
  const posted = status === '待质检' || status === '已完成'
  return {
    id,
    status: posted ? LEDGER_POSTED : LEDGER_RETURNED,
    pending: posted,
    abnormal: false,
    作业编号: String(row['作业编号'] ?? ''),
    航班号: String(row['航班号'] ?? ''),
    清洁班组: String(row['清洁班组'] ?? ''),
    耗材领用: posted ? Number(row['已挂账耗材'] ?? 0) : 0,
    用水量: posted ? Number(row['已挂账用水'] ?? 0) : 0,
    最近时间: todayText(),
  }
}

type ReconcileOptions = {
  // 传入尚未落盘的作业表时，以它为准计算（一次事务内使用）；否则读当前持久化数据。
  entries?: Record<string, EntryRow[]>
  // 是否把对账结果写回持久化层，把历史旧值/重复/残留一次性修干净。
  writeThrough?: boolean
}

// 台账对账：同一份领用数据在页面动作、台账两个入口都可能被写，这里统一裁决——
// 作业记录怎么写，台账就怎么算。重复落账按作业编号去重（只留一条），
// 数值冲突、退回后残留一律以作业记录覆盖，找不到作业的无主挂账直接清除。
export function reconcileLedger(options: ReconcileOptions = {}): LedgerResult {
  const { entries, writeThrough = true } = options
  const source = entries ?? allRows()
  const jobs = source[CABIN_KEY] ?? []

  const items: LedgerRow[] = []
  const seen = new Set<string>()
  let nextId = 0
  for (const job of jobs) {
    const code = String(job['作业编号'] ?? '')
    if (!code || seen.has(code)) {
      continue
    }
    seen.add(code)
    nextId += 1
    items.push(ledgerFromJob(job, nextId))
  }
  // 旧台账里与作业对不上的无主挂账不会出现在 items 里，等于直接清除；
  // 对得上的条目数值全部来自作业快照，旧值不再被采信。

  const statMap = new Map<string, TeamLedgerStat>()
  for (const item of items) {
    if (item.status !== LEDGER_POSTED) {
      continue
    }
    const team = item.清洁班组 || '未分配班组'
    const stat = statMap.get(team) ?? { 清洁班组: team, 领用合计: 0, 用水合计: 0, 挂账笔数: 0 }
    stat.领用合计 += item.耗材领用
    stat.用水合计 += item.用水量
    stat.挂账笔数 += 1
    statMap.set(team, stat)
  }

  const result: LedgerResult = { items, teamStats: [...statMap.values()] }
  if (writeThrough) {
    saveLedger(items)
  }
  return result
}

// 客舱清洁专用动作：状态、耗材领用、用水量（连带班组台账）一次事务整体处理。
function runCabinAction(
  meta: ModuleMeta,
  id: number,
  action: string,
  target: string,
): ActionResult {
  const rows = listRowsSafe(CABIN_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = rows[index]
  const currentStatus = String(current.status)

  if (currentStatus === target) {
    // 退回幂等：已经是清洁中说明这笔退回已经扣减过，直接拦下，绝不重复扣。
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const allowed = meta.actionSources?.[action]
  if (allowed && !allowed.includes(currentStatus)) {
    return {
      ok: false,
      message: `「${action}」只能从${allowed.join('、')}发起，当前是「${currentStatus}」，不允许跨级操作`,
    }
  }

  let updated: EntryRow = {
    ...current,
    status: target,
    pending: target !== '已完成',
    abnormal: isNegative(action),
  }

  if (action === '提交质检') {
    // 清洁中 → 待质检：把这一轮的耗材/用水量固化成挂账快照，班组台账据此落账。
    updated = {
      ...updated,
      质检人员: current['质检人员'] === '' ? '值班质检' : current['质检人员'],
      '已挂账耗材': Number(current['耗材领用'] ?? 0),
      '已挂账用水': Number(current['用水量'] ?? 0),
      abnormal: false,
    }
  } else if (action === '质检退回') {
    // 待质检 → 清洁中：整体回落。耗材领用、用水量连同挂账快照一起清零，
    // 不存在「状态退了、领用还挂着」的半成品；返工后重新清洁、重新提交，按新一轮的值重新挂账，
    // 从根上杜绝「过几天再做一遍又累加一次」。
    updated = {
      ...updated,
      '耗材领用': 0,
      '用水量': 0,
      '已挂账耗材': 0,
      '已挂账用水': 0,
      '质检人员': '',
    }
  }

  const nextRows = [...rows]
  nextRows[index] = updated
  const nextEntries = { ...allRows(), [CABIN_KEY]: nextRows }

  // 台账基于同一份尚未落盘的新作业表重算，再与作业行一次提交落盘：
  // 状态、耗材、用水、台账要么一起生效，要么都不动。
  const ledger = reconcileLedger({ entries: nextEntries, writeThrough: false }).items
  commitAll(nextEntries, ledger)

  const suffix =
    action === '质检退回'
      ? '，耗材领用与用水量已整体回滚，班组领用清单同步冲减'
      : action === '提交质检'
        ? '，耗材与用水量已记入保障班组领用清单'
        : ''
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」${suffix}` }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  if (key === CABIN_KEY) {
    return runCabinAction(meta, id, action, target)
  }

  const rows = listRowsSafe(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  const allowed = meta.actionSources?.[action]
  if (allowed && !allowed.includes(current)) {
    return {
      ok: false,
      message: `「${action}」只能从${allowed.join('、')}发起，当前是「${current}」，不允许跨级操作`,
    }
  }
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: isNegative(action),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  if (key === CABIN_KEY) {
    resetCabin()
  } else {
    resetRows(key)
  }
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRowsSafe(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
