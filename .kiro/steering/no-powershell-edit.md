# 禁止使用 PowerShell/命令行修改代码文件

## 规则

**绝对禁止**使用 `execute_command` 工具通过 PowerShell/命令行方式修改源代码文件。

具体禁止的操作包括：
- 使用 `Set-Content`、`Out-File`、`Add-Content` 写代码文件
- 使用 `sed`、`awk` 替换代码文件内容
- 使用 `>>` 或 `>` 重定向输出覆盖代码文件
- 使用 `node -e "fs.writeFileSync(...)"` 写代码文件
- 任何通过命令行间接修改 `.ts`、`.tsx`、`.js`、`.py`、`.json` 等源文件的行为

## 正确做法

- 使用 `create_file` 工具创建新文件
- 使用 `str_replace` 工具精确替换文件内容
- `str_replace` 多次失败时：
  1. 先用 `read_file` 重新读取最新内容
  2. 基于最新内容重新构造准确的 `oldStr`
  3. 如果文件内容复杂到无法精确匹配，使用 `create_file` + `overwrite=true` 整文件重写

## 例外

`execute_command` 只允许用于：
- 运行验证脚本（`node -e "console.log(...)"` 验证行为）
- 执行构建/测试/lint 命令
- 查看系统状态（环境变量、进程列表等）
- 运行一次性临时脚本（但脚本本身要用 `create_file` 创建）
