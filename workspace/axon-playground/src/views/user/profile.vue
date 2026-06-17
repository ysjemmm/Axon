<script setup lang="ts">
/**
 * 个人设置页面
 * 展示当前用户信息，支持修改密码
 */
import { ref, reactive, onMounted } from 'vue'
import { useUserStore } from '@/store/user'
import { updatePassword } from '@/api/user'
import type { UpdatePasswordParams } from '@/types/user'

const userStore = useUserStore()
const activeTab = ref('info')

// 密码表单
const passwordForm = reactive<UpdatePasswordParams>({
  oldPassword: '',
  newPassword: '',
  confirmPassword: '',
})
const passwordFormRef = ref<any>(null)
const changingPassword = ref(false)

/** 提交修改密码 */
async function handleChangePassword() {
  const errors = await passwordFormRef.value?.validate()
  if (errors) return

  changingPassword.value = true
  try {
    await updatePassword(passwordForm)
    // 成功后清空表单
    passwordForm.oldPassword = ''
    passwordForm.newPassword = ''
    passwordForm.confirmPassword = ''
    passwordFormRef.value?.clearValidate()
  } catch (error) {
    console.error('[Profile] 修改密码失败:', error)
  } finally {
    changingPassword.value = false
  }
}

/** 确认密码校验规则 */
function confirmPasswordValidator(value: string, callback: (error?: string) => void) {
  if (value !== passwordForm.newPassword) {
    callback('两次输入的密码不一致')
  } else {
    callback()
  }
}

onMounted(() => {
  console.log('[Profile] 加载用户信息')
})
</script>

<template>
  <div class="user-profile">
    <a-card title="个人设置">
      <a-tabs v-model:active-key="activeTab">
        <!-- 基本信息 -->
        <a-tab-pane key="info" title="基本信息">
          <a-descriptions :column="2" bordered style="max-width: 600px">
            <a-descriptions-item label="姓名">{{ userStore.userName }}</a-descriptions-item>
            <a-descriptions-item label="头像">
              <a-avatar :size="40">{{ userStore.userName.slice(0, 1) }}</a-avatar>
            </a-descriptions-item>
            <a-descriptions-item label="邮箱">{{ userStore.userInfo?.email || '-' }}</a-descriptions-item>
            <a-descriptions-item label="手机号">{{ userStore.userInfo?.phone || '-' }}</a-descriptions-item>
            <a-descriptions-item label="部门">{{ userStore.userInfo?.departmentName || '-' }}</a-descriptions-item>
            <a-descriptions-item label="角色">
              <a-tag v-for="role in (userStore.userInfo?.roles || [])" :key="role">{{ role }}</a-tag>
            </a-descriptions-item>
          </a-descriptions>
        </a-tab-pane>

        <!-- 修改密码 -->
        <a-tab-pane key="password" title="修改密码">
          <a-form
            ref="passwordFormRef"
            :model="passwordForm"
            layout="vertical"
            style="max-width: 400px"
          >
            <a-form-item
              field="oldPassword"
              label="当前密码"
              :rules="[{ required: true, message: '请输入当前密码' }]"
            >
              <a-input-password v-model="passwordForm.oldPassword" placeholder="请输入当前密码" />
            </a-form-item>
            <a-form-item
              field="newPassword"
              label="新密码"
              :rules="[
                { required: true, message: '请输入新密码' },
                { minLength: 8, message: '密码至少 8 位' },
              ]"
            >
              <a-input-password v-model="passwordForm.newPassword" placeholder="请输入新密码（至少 8 位）" />
            </a-form-item>
            <a-form-item
              field="confirmPassword"
              label="确认新密码"
              :rules="[
                { required: true, message: '请确认新密码' },
                { validator: confirmPasswordValidator },
              ]"
            >
              <a-input-password v-model="passwordForm.confirmPassword" placeholder="请再次输入新密码" />
            </a-form-item>
            <a-form-item>
              <a-button type="primary" :loading="changingPassword" @click="handleChangePassword">
                确认修改
              </a-button>
            </a-form-item>
          </a-form>
        </a-tab-pane>
      </a-tabs>
    </a-card>
  </div>
</template>

<style scoped lang="less">
.user-profile {
  max-width: 800px;
}
</style>
