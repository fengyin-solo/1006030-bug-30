import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveModuleRows } from '@/data/local-store'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚', '退回']

// 客舱清洁的挂账口径：提交质检时把本轮用水量、耗材领用记到作业记录上（挂账快照），
// 同时累加进保障班组的领用台账；质检退回时按快照整体回落。两边对不上时以作业记录上的
// 挂账快照为准——领用发生在作业上，班组台账只是这份事实的汇总，只能跟着快照加减。
const CABIN_BOOKED_WATER = '挂账用水量'
const CABIN_BOOKED_SUPPLIES = '挂账耗材领用'

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
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  const source = meta.actionSources?.[action]
  if (source && current !== source) {
    return { ok: false, message: `${meta.entity}当前状态「${current}」，「${action}」只能从「${source}」发起，已按跨级流转驳回` }
  }
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.includes(verb)),
  }
  // 状态与派生数据放在同一笔写入里：先在各模块的副本上算完，再一次落盘，要么一起改要么都不改。
  const writes: Record<string, EntryRow[]> = { [key]: [...rows] }
  writes[key][index] = updated
  if (key === 'cabin' && action === '提交质检') {
    const failure = applyCabinBooking(writes, index)
    if (failure) {
      return failure
    }
  }
  if (key === 'cabin' && action === '质检退回') {
    const failure = applyCabinRollback(writes, index)
    if (failure) {
      return failure
    }
  }
  saveModuleRows(writes)
  let message = `${meta.entity}已${action}，当前状态「${target}」`
  if (key === 'cabin' && action === '质检退回') {
    message += '，耗材领用、用水量与班组领用台账已一并回落'
  }
  return { ok: true, message }
}

function toAmount(value: unknown): number {
  const num = Number(value)
  return Number.isFinite(num) ? num : 0
}

// 找到清洁班组对应的保障班组行：挂账与回落都要落到这张领用清单上，找不到就整笔取消。
function withTeamLedger(
  writes: Record<string, EntryRow[]>,
  teamCode: string,
  apply: (ledger: number) => number,
): ActionResult | null {
  const teamRows = [...(writes['team'] ?? listRows('team'))]
  const teamIndex = teamRows.findIndex((row) => String(row['班组编号']) === teamCode)
  if (teamIndex < 0) {
    return { ok: false, message: `清洁班组 ${teamCode} 在保障班组里查不到，领用台账没法同步，本次操作已整体取消` }
  }
  const row = teamRows[teamIndex]
  teamRows[teamIndex] = { ...row, '耗材领用': Math.max(0, apply(toAmount(row['耗材领用']))) }
  writes['team'] = teamRows
  return null
}

// 提交质检：本轮用水量、耗材领用挂上账（快照留在作业记录上），班组领用台账同步累加。
function applyCabinBooking(writes: Record<string, EntryRow[]>, index: number): ActionResult | null {
  const cabinRows = writes['cabin']
  const row = cabinRows[index]
  const water = toAmount(row['用水量'])
  const supplies = toAmount(row['耗材领用'])
  const teamCode = String(row['清洁班组'] ?? '').trim()
  if (teamCode) {
    const failure = withTeamLedger(writes, teamCode, (ledger) => ledger + supplies)
    if (failure) {
      return failure
    }
  }
  cabinRows[index] = { ...row, [CABIN_BOOKED_WATER]: water, [CABIN_BOOKED_SUPPLIES]: supplies }
  return null
}

// 质检退回：状态、耗材领用、用水量三处一起回落。扣减量以挂账快照为准，扣完即清快照——
// 重复提交退回会先被来源状态校验拦住，即便再进来快照也是 0，不会反复扣。
function applyCabinRollback(writes: Record<string, EntryRow[]>, index: number): ActionResult | null {
  const cabinRows = writes['cabin']
  const row = cabinRows[index]
  const bookedWater = toAmount(row[CABIN_BOOKED_WATER])
  const bookedSupplies = toAmount(row[CABIN_BOOKED_SUPPLIES])
  const teamCode = String(row['清洁班组'] ?? '').trim()
  if (teamCode) {
    const failure = withTeamLedger(writes, teamCode, (ledger) => ledger - bookedSupplies)
    if (failure) {
      return failure
    }
  }
  cabinRows[index] = {
    ...row,
    '用水量': Math.max(0, toAmount(row['用水量']) - bookedWater),
    '耗材领用': Math.max(0, toAmount(row['耗材领用']) - bookedSupplies),
    [CABIN_BOOKED_WATER]: 0,
    [CABIN_BOOKED_SUPPLIES]: 0,
  }
  return null
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
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
