<template>
  <section class="page" data-module="cabin">
    <header class="page-head">
      <div>
        <h2>客舱清洁管理</h2>
        <p class="page-desc">维护清洁作业，围绕作业编号、航班号、清洁班组、作业项数做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记清洁作业</button>
        <button class="btn" type="button" @click="exportRows">导出客舱清洁清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actionsFor(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无客舱清洁数据，可先登记清洁作业</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条客舱清洁记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  reconcileLedger,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('cabin')
const columns = ["作业编号", "航班号", "清洁班组", "作业项数", "用水量", "耗材领用", "质检人员", "作业状态"]
const statuses = ["待清洁", "清洁中", "待质检", "已完成"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

// 每行只给当前状态允许的动作：待质检之前不出现「确认完成」，
// 只有待质检的作业才给「质检退回」，跨级操作在页面上就没有入口。
const ACTIONS_BY_STATUS: Record<string, string[]> = {
  "待清洁": ["开始清洁"],
  "清洁中": ["提交质检"],
  "待质检": ["质检退回", "确认完成"],
  "已完成": [],
}

function actionsFor(row: EntryRow): string[] {
  return ACTIONS_BY_STATUS[String(row.status)] ?? []
}

// 统计卡直接取数：架次看作业表，领用/用水看班组领用清单（只计挂账，退回后不残留）。
const stats = computed(() => {
  const ledger = reconcileLedger()
  const cleaning = rows.value.filter((row) => String(row.status) === '清洁中').length
  const pendingQc = rows.value.filter((row) => String(row.status) === '待质检').length
  const materials = ledger.teamStats.reduce((sum, item) => sum + item.领用合计, 0)
  const water = ledger.teamStats.reduce((sum, item) => sum + item.用水合计, 0)
  return [
    { label: '今日清洁架次', value: rows.value.length },
    { label: '清洁中作业', value: cleaning },
    { label: '待质检作业', value: pendingQc },
    { label: '班组挂账耗材', value: materials },
    { label: '班组挂账用水', value: water },
  ]
})

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '清洁作业登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    // 读取前先按作业记录对账台账：重复条目去重、退回残留冲减、无主挂账清除。
    reconcileLedger()
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '客舱清洁列表读取失败'
  }
}

onMounted(reload)
</script>
