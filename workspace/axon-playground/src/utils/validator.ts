/**
 * 表单验证器
 * 提供常用的自定义验证规则
 */

/** 验证回调类型 */
type ValidatorCallback = (error?: string) => void

/**
 * 手机号验证
 * @param value 输入值
 * @param callback 回调函数
 */
export function validatePhone(value: string, callback: ValidatorCallback): void {
  if (!value) {
    callback()
    return
  }
  const phoneReg = /^1[3-9]\d{9}$/
  if (!phoneReg.test(value)) {
    callback('请输入正确的手机号码')
  } else {
    callback()
  }
}

/**
 * 邮箱验证
 * @param value 输入值
 * @param callback 回调函数
 */
export function validateEmail(value: string, callback: ValidatorCallback): void {
  if (!value) {
    callback()
    return
  }
  const emailReg = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/
  if (!emailReg.test(value)) {
    callback('请输入正确的邮箱地址')
  } else {
    callback()
  }
}

/**
 * 密码强度验证（至少包含大小写字母和数字）
 * @param value 输入值
 * @param callback 回调函数
 */
export function validatePassword(value: string, callback: ValidatorCallback): void {
  if (!value) {
    callback('请输入密码')
    return
  }
  if (value.length < 8) {
    callback('密码至少 8 位')
    return
  }
  const hasUpperCase = /[A-Z]/.test(value)
  const hasLowerCase = /[a-z]/.test(value)
  const hasNumber = /\d/.test(value)
  if (!hasUpperCase || !hasLowerCase || !hasNumber) {
    callback('密码需包含大小写字母和数字')
  } else {
    callback()
  }
}

/**
 * URL 地址验证
 * @param value 输入值
 * @param callback 回调函数
 */
export function validateUrl(value: string, callback: ValidatorCallback): void {
  if (!value) {
    callback()
    return
  }
  const urlReg = /^https?:\/\/.+/
  if (!urlReg.test(value)) {
    callback('请输入正确的 URL 地址（以 http:// 或 https:// 开头）')
  } else {
    callback()
  }
}

/**
 * 项目编号验证（字母开头，仅包含字母、数字和短横线）
 * @param value 输入值
 * @param callback 回调函数
 */
export function validateProjectCode(value: string, callback: ValidatorCallback): void {
  if (!value) {
    callback('请输入项目编号')
    return
  }
  const codeReg = /^[a-zA-Z][a-zA-Z0-9-]{2,19}$/
  if (!codeReg.test(value)) {
    callback('项目编号需以字母开头，仅含字母/数字/短横线，3~20 位')
  } else {
    callback()
  }
}

/**
 * 非空字符串验证（去除首尾空格后判断）
 * @param value 输入值
 * @param callback 回调函数
 */
export function validateNotEmpty(value: string, callback: ValidatorCallback): void {
  if (!value || !value.trim()) {
    callback('不能为空')
  } else {
    callback()
  }
}