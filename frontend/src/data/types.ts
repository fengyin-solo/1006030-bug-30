/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  // 动作允许的源状态白名单：不填沿用旧行为（只看目标态）；填了就做跨级拦截。
  actionSources?: Record<string, string[]>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

// 保障班组领用清单（班组台账）：每笔清洁作业提交质检时按作业编号落一条，退回时整条回落。
// 它是客舱清洁作业记录的派生产物，作业记录是唯一事实源，台账与之冲突一律以作业记录为准。
export type LedgerRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  作业编号: string
  航班号: string
  清洁班组: string
  耗材领用: number
  用水量: number
  最近时间: string
  [field: string]: string | number | boolean
}

export type TeamLedgerStat = {
  清洁班组: string
  领用合计: number
  用水合计: number
  挂账笔数: number
}

export type LedgerResult = {
  items: LedgerRow[]
  teamStats: TeamLedgerStat[]
}
