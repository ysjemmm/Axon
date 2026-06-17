import { ref, reactive, computed, watch } from 'vue'
import type { PageQuery, PageResult } from '@/types/common'

/**
 * 通用表格逻辑 composable
 * 封装分页、加载、搜索等表格常用操作
 */
export function useTable<T>(
  fetchApi: (params: PageQuery & Record<string, any>) => Promise<any>
) {
  // 表格数据
  const tableData = ref<T[]>([]) as any
  const loading = ref(false)
  const selectedKeys = ref<string[]>([])

  // 分页参数
  const pagination = reactive<PageQuery>({
    page: 1,
    pageSize: 20,
    sortField: undefined,
    sortOrder: undefined,
  })

  // 额外筛选条件
  const filters = reactive<Record<string, any>>({})

  // 分页信息
  const total = ref(0)
  const totalPages = computed(() => Math.ceil(total.value / pagination.pageSize))

  /** 加载表格数据 */
  async function fetchData() {
    loading.value = true
    try {
      const params = { ...pagination, ...filters }
      const res = await fetchApi(params)
      const result: PageResult<T> = res.data
      tableData.value = result.list
      total.value = result.total
    } catch (error) {
      console.error('[useTable] 加载数据失败:', error)
      tableData.value = []
      total.value = 0
    } finally {
      loading.value = false
    }
  }

  /** 翻页 */
  function handlePageChange(page: number) {
    pagination.page = page
    fetchData()
  }

  /** 切换每页条数 */
  function handlePageSizeChange(pageSize: number) {
    pagination.pageSize = pageSize
    pagination.page = 1
    fetchData()
  }

  /** 排序变化 */
  function handleSortChange(field: string, order: 'ascend' | 'descend') {
    pagination.sortField = field
    pagination.sortOrder = order
    fetchData()
  }

  /** 重置到第一页并刷新 */
  function refresh() {
    pagination.page = 1
    fetchData()
  }

  /** 设置筛选条件 */
  function setFilter(key: string, value: any) {
    filters[key] = value
  }

  /** 清空选中 */
  function clearSelection() {
    selectedKeys.value = []
  }

  // 监听筛选条件变化自动刷新
  watch(
    () => ({ ...filters }),
    () => {
      pagination.page = 1
      fetchData()
    },
    { deep: true }
  )

  return {
    tableData,
    loading,
    selectedKeys,
    pagination,
    total,
    totalPages,
    filters,
    fetchData,
    handlePageChange,
    handlePageSizeChange,
    handleSortChange,
    refresh,
    setFilter,
    clearSelection,
  }
}
