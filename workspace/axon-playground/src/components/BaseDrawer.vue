<script setup lang="ts">
/**
 * 通用抽屉组件
 * 基于 Arco Design Drawer 封装，统一页面抽屉交互
 */
import { computed } from 'vue'

interface Props {
  /** 是否显示 */
  visible: boolean
  /** 标题 */
  title: string
  /** 宽度 */
  width?: number | string
  /** 是否显示底部操作栏 */
  showFooter?: boolean
  /** 确认按钮文字 */
  okText?: string
  /** 取消按钮文字 */
  cancelText?: string
  /** 确认按钮加载状态 */
  okLoading?: boolean
  /** 点击遮罩是否可关闭 */
  maskClosable?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  width: 600,
  showFooter: true,
  okText: '确定',
  cancelText: '取消',
  okLoading: false,
  maskClosable: true,
})

const emit = defineEmits<{
  (e: 'update:visible', visible: boolean): void
  (e: 'ok'): void
  (e: 'cancel'): void
}>()

const innerVisible = computed({
  get: () => props.visible,
  set: (val) => emit('update:visible', val),
})

function handleOk() {
  emit('ok')
}

function handleCancel() {
  emit('cancel')
  innerVisible.value = false
}
</script>

<template>
  <a-drawer
    v-model:visible="innerVisible"
    :title="title"
    :width="width"
    :mask-closable="maskClosable"
    :footer="showFooter"
    unmount-on-close
  >
    <slot />

    <template v-if="showFooter" #footer>
      <div class="drawer-footer">
        <a-button @click="handleCancel">{{ cancelText }}</a-button>
        <a-button type="primary" :loading="okLoading" @click="handleOk">
          {{ okText }}
        </a-button>
      </div>
    </template>
  </a-drawer>
</template>

<style scoped lang="less">
.drawer-footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
}
</style>
