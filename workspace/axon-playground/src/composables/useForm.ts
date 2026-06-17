import { ref, reactive, computed } from 'vue'

/**
 * 通用表单逻辑 composable
 * 封装表单提交、验证、重置等操作
 */
export function useForm<T extends Record<string, any>>(
  defaultValues: T,
  submitApi?: (data: T) => Promise<any>
) {
  // 表单数据（使用 reactive 保持响应性）
  const formData = reactive<T>({ ...defaultValues })
  const formRef = ref<any>(null)
  const submitting = ref(false)
  const submitError = ref<string>('')

  // 表单是否被修改过
  const isDirty = computed(() => {
    return JSON.stringify(formData) !== JSON.stringify(defaultValues)
  })

  /** 重置表单为默认值 */
  function resetForm() {
    Object.keys(defaultValues).forEach((key) => {
      ;(formData as any)[key] = (defaultValues as any)[key]
    })
    submitError.value = ''
    formRef.value?.clearValidate()
  }

  /** 设置表单值（用于编辑场景） */
  function setFormData(data: Partial<T>) {
    Object.keys(data).forEach((key) => {
      if (key in formData) {
        ;(formData as any)[key] = (data as any)[key]
      }
    })
  }

  /** 提交表单 */
  async function handleSubmit(): Promise<boolean> {
    // 表单校验
    if (formRef.value) {
      const errors = await formRef.value.validate()
      if (errors) {
        return false
      }
    }

    if (!submitApi) return true

    submitting.value = true
    submitError.value = ''

    try {
      await submitApi(formData as T)
      return true
    } catch (error: any) {
      submitError.value = error.message || '提交失败，请稍后重试'
      return false
    } finally {
      submitting.value = false
    }
  }

  /** 校验单个字段 */
  function validateField(field: string) {
    formRef.value?.validateField(field)
  }

  return {
    formData,
    formRef,
    submitting,
    submitError,
    isDirty,
    resetForm,
    setFormData,
    handleSubmit,
    validateField,
  }
}
