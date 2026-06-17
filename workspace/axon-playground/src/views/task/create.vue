<script setup lang="ts">
/**
 * 创建任务页面
 * 包含表单验证、人员选择、项目选择等
 */
import { useRouter } from 'vue-router'
import { useForm } from '@/composables/useForm'
import { createTask } from '@/api/task'
import { TaskPriority, TaskType } from '@/types/task'
import type { CreateTaskParams } from '@/types/task'

const router = useRouter()

// 表单默认值
const defaultValues: CreateTaskParams = {
  title: '',
  projectId: '',
  description: '',
  priority: TaskPriority.Medium,
  type: TaskType.Development,
  assigneeId: '',
  estimatedHours: undefined,
  deadline: undefined,
  tags: [],
}

const { formData, formRef, submitting, submitError, handleSubmit, resetForm } =
  useForm<CreateTaskParams>(defaultValues, createTask)

/** 提交表单 */
async function onSubmit() {
  const success = await handleSubmit()
  if (success) {
    router.push('/task/list')
  }
}

/** 取消返回 */
function handleCancel() {
  router.back()
}

/** 任务类型选项 */
const typeOptions = [
  { label: '开发', value: TaskType.Development },
  { label: '测试', value: TaskType.Testing },
  { label: '设计', value: TaskType.Design },
  { label: '文档', value: TaskType.Documentation },
  { label: '缺陷修复', value: TaskType.BugFix },
]

/** 优先级选项 */
const priorityOptions = [
  { label: '低', value: TaskPriority.Low },
  { label: '中', value: TaskPriority.Medium },
  { label: '高', value: TaskPriority.High },
  { label: '紧急', value: TaskPriority.Urgent },
]
</script>

<template>
  <div class="task-create">
    <a-card title="创建任务">
      <a-alert v-if="submitError" type="error" :content="submitError" closable style="margin-bottom: 16px" />

      <a-form
        ref="formRef"
        :model="formData"
        layout="vertical"
        style="max-width: 600px"
      >
        <a-form-item
          field="title"
          label="任务标题"
          :rules="[{ required: true, message: '请输入任务标题' }]"
        >
          <a-input v-model="formData.title" placeholder="请输入任务标题" :max-length="100" />
        </a-form-item>

        <a-form-item
          field="projectId"
          label="所属项目"
          :rules="[{ required: true, message: '请选择所属项目' }]"
        >
          <a-select v-model="formData.projectId" placeholder="请选择项目" allow-search>
            <!-- 实际项目中动态加载项目列表 -->
          </a-select>
        </a-form-item>

        <a-form-item field="type" label="任务类型">
          <a-select v-model="formData.type" placeholder="请选择任务类型">
            <a-option v-for="opt in typeOptions" :key="opt.value" :value="opt.value" :label="opt.label" />
          </a-select>
        </a-form-item>

        <a-form-item field="priority" label="优先级">
          <a-radio-group v-model="formData.priority">
            <a-radio v-for="opt in priorityOptions" :key="opt.value" :value="opt.value">
              {{ opt.label }}
            </a-radio>
          </a-radio-group>
        </a-form-item>

        <a-form-item
          field="assigneeId"
          label="负责人"
          :rules="[{ required: true, message: '请选择负责人' }]"
        >
          <PersonSelect v-model="formData.assigneeId" />
        </a-form-item>

        <a-form-item field="deadline" label="截止日期">
          <a-date-picker v-model="formData.deadline" style="width: 100%" />
        </a-form-item>

        <a-form-item field="estimatedHours" label="预估工时（小时）">
          <a-input-number v-model="formData.estimatedHours" :min="0" :max="999" placeholder="请输入预估工时" />
        </a-form-item>

        <a-form-item field="description" label="任务描述">
          <a-textarea v-model="formData.description" placeholder="请输入任务描述" :max-length="2000" :auto-size="{ minRows: 4, maxRows: 8 }" />
        </a-form-item>

        <a-form-item>
          <a-space>
            <a-button type="primary" :loading="submitting" @click="onSubmit">提交</a-button>
            <a-button @click="resetForm">重置</a-button>
            <a-button @click="handleCancel">取消</a-button>
          </a-space>
        </a-form-item>
      </a-form>
    </a-card>
  </div>
</template>

<style scoped lang="less">
.task-create {
  max-width: 800px;
}
</style>
