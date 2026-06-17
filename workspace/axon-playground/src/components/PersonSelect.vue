<script setup lang="ts">
/**
 * 人员选择器组件
 * 支持搜索、远程加载人员数据
 */
import { ref, computed, onMounted } from 'vue'
import type { UserListItem } from '@/types/user'

interface Props {
  /** 选中的用户 ID */
  modelValue?: string
  /** 占位文字 */
  placeholder?: string
  /** 是否支持多选 */
  multiple?: boolean
  /** 是否禁用 */
  disabled?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  modelValue: undefined,
  placeholder: '请选择人员',
  multiple: false,
  disabled: false,
})

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void
  (e: 'change', user: UserListItem | undefined): void
}>()

// 人员列表数据
const personList = ref<UserListItem[]>([])
const loading = ref(false)
const searchKeyword = ref('')

// 根据搜索关键字过滤人员列表
const filteredList = computed(() => {
  if (!searchKeyword.value) return personList.value
  const keyword = searchKeyword.value.toLowerCase()
  return personList.value.filter(
    (person) =>
      person.name.toLowerCase().includes(keyword) ||
      person.account.toLowerCase().includes(keyword)
  )
})

/** 模拟加载人员数据 */
async function loadPersons() {
  loading.value = true
  try {
    // 实际项目中调用 API
    // const res = await getAllPersons()
    // personList.value = res.data
    personList.value = [] // 演示项目留空
  } finally {
    loading.value = false
  }
}

/** 搜索处理 */
function handleSearch(value: string) {
  searchKeyword.value = value
}

/** 选中变化 */
function handleChange(value: string) {
  emit('update:modelValue', value)
  const selectedUser = personList.value.find((p) => p.id === value)
  emit('change', selectedUser)
}

onMounted(() => {
  loadPersons()
})
</script>

<template>
  <a-select
    :model-value="modelValue"
    :placeholder="placeholder"
    :multiple="multiple"
    :disabled="disabled"
    :loading="loading"
    allow-search
    allow-clear
    @search="handleSearch"
    @change="handleChange"
  >
    <a-option
      v-for="person in filteredList"
      :key="person.id"
      :value="person.id"
      :label="person.name"
    >
      <div class="person-option">
        <a-avatar :size="24">{{ person.name.slice(0, 1) }}</a-avatar>
        <span class="person-option__name">{{ person.name }}</span>
        <span class="person-option__dept">{{ person.departmentName }}</span>
      </div>
    </a-option>
  </a-select>
</template>

<style scoped lang="less">
.person-option {
  display: flex;
  align-items: center;
  gap: 8px;

  &__name {
    font-size: 14px;
  }

  &__dept {
    font-size: 12px;
    color: #86909c;
  }
}
</style>
