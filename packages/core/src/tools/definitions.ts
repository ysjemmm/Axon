/**
 * 工具定义与相关纯类型（迁移自 tools.ts，零 host 依赖）
 *
 * 这些是传给 LLM 的 function 定义、只读工具白名单、ToolMeta 等纯数据/类型，
 * 与执行端无关，原样保留以确保模型行为完全不变。
 */

/** 工具定义列表（传给 LLM）。内容与 server/src/tools.ts getToolDefinitions 完全一致。 */
export function getToolDefinitions() {
  return [
    {
      type: "function" as const,
      function: {
        name: "read_file",
        description: "读取指定路径的文件内容。优先一次读完整文件或一大段，不要零碎分多次读重叠区间。小文件（≤约400行）省略 startLine/endLine 直接读全文。大文件用 startLine/endLine 一次读足够大的范围（目标 ±50~100 行，覆盖完整函数/类）。已经读过的内容会留在上下文里，不要重复读同一区域。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "文件路径" },
            startLine: { type: "number", description: "起始行号（1-indexed，可选）。指定后从该行开始读取" },
            endLine: { type: "number", description: "结束行号（1-indexed，包含此行，可选）。省略表示读到文件末尾" },
          },
          required: ["path"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "create_file",
        description:
          "创建新文件并写入内容。\n\n" +
          "【调用前必须确认目录】新建文件前，必须先用 list_dir 或 search(mode=file) 查看目标目录。" +
          "目的是确认没有同名文件——但搜索时 intent 写自然一点（如\"查看当前目录\"），不要写成\"检查是否有同名文件\"。" +
          "不要凭对话历史或记忆判断目录状态，必须实时确认。\n\n" +
          "【发现已有同名文件时】不要直接覆盖或换名自作主张。向用户说明（如\"当前目录已存在 hello.py，要覆盖还是换一个文件名？\"），" +
          "等用户回复后再行动。\n\n" +
          "【防覆盖保护】如果你未经确认直接调用，且目标路径已存在文件：\n" +
          "- 手动模式：覆盖改动会暂存为待确认，交给用户决定；\n" +
          "- 自动模式：工具会提示你改用 str_replace 或补 overwrite=true。\n\n" +
          "【何时传 overwrite=true】仅在用户明确说了\"覆盖/重写\"、或 str_replace 多次失败后兜底整文件重写时。\n\n" +
          "【已存在文件做局部修改】应优先用 str_replace。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "文件路径" },
            content: { type: "string", description: "文件内容" },
            overwrite: { type: "boolean", description: "目标文件已存在时是否覆盖。默认 false（已存在则拒绝）。仅在用户明确要求覆盖/重写、或整文件重写兜底时设为 true" },
          },
          required: ["path", "content"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "str_replace",
        description: "替换文件中的指定文本，oldStr 必须精确匹配",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "文件路径" },
            oldStr: { type: "string", description: "要替换的原始文本" },
            newStr: { type: "string", description: "替换后的文本" },
          },
          required: ["path", "oldStr", "newStr"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "apply_patch",
        description:
          "对一个或多个【已存在文件】做多处编辑的首选工具——尤其是大文件、改动分散在多处时。\n" +
          "相比 str_replace/create_file，它只输出变更块（每块带少量上下文行），不重述未改动内容，输出更少、更快。\n\n" +
          "【补丁格式】严格如下（前缀很重要）：\n" +
          "*** Begin Patch\n" +
          "*** Update File: 相对或绝对路径\n" +
          "@@\n" +
          " 不变的上下文行（前缀是一个空格）\n" +
          "-要删除的行（前缀 -）\n" +
          "+要新增的行（前缀 +）\n" +
          " 不变的上下文行\n" +
          "@@\n" +
          "（同一文件的下一个变更块，用 @@ 分隔）\n" +
          "*** End Patch\n\n" +
          "【规则】\n" +
          "- 每个变更块必须包含至少 1~3 行带空格前缀的上下文行，用于在文件中唯一定位；上下文要与文件逐字符一致（含缩进）。\n" +
          "- 上下文不唯一会失败，需要多带几行上下文。\n" +
          "- 多个文件：重复 '*** Update File:' 段。新建文件用 '*** Add File: 路径' 后跟若干 '+行'。\n" +
          "- 只能改已存在文件；整文件重写或新建大文件仍用 create_file。\n" +
          "- 失败时会返回实际内容附近片段，据此修正上下文重试。",
        parameters: {
          type: "object",
          properties: {
            patch: { type: "string", description: "完整补丁文本（*** Begin Patch ... *** End Patch）" },
          },
          required: ["patch"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "execute_command",
        description: "在 Axon 终端中执行 shell 命令。每条命令执行前系统会自动 cd 到指定的 cwd 目录，确保执行环境正确。严禁在命令中使用 cd、Set-Location、pushd 等切换目录的指令——它们会污染终端状态。如需在子目录执行，用 cwd 参数指定。\n\n【命令书写安全】优先写简单、短小、可直接执行的一行命令。避免在 command 中拼接复杂引号/括号/多行脚本/正则嵌套/JSON 字符串；这类命令很容易让 PowerShell 进入 `>>` 续行/等待输入状态。遇到复杂逻辑请改为创建临时 .ps1/.js/.cjs 脚本文件再执行，或拆成多条简单命令。若工具提示命令疑似进入续行/等待输入状态，禁止原样重试，必须换成临时脚本或简化命令。",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "要执行的命令。禁止包含 cd / Set-Location / pushd 等目录切换指令" },
            cwd: { type: "string", description: "工作目录（绝对路径）。系统会在执行命令前无条件 cd 到此目录。不传则使用会话默认工作区根目录" },
          },
          required: ["command"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "start_process",
        description:
          "启动一个【常驻/长时间运行】的后台进程，立即返回不阻塞——专用于开发服务器、watch、构建监听等不会自己结束的命令。\n\n" +
          "【何时必须用它而不是 execute_command】\n" +
          "- 开发服务器：npm run dev / pnpm dev / yarn start / vite / next dev\n" +
          "- 监听/守护：webpack --watch / tsc --watch / nodemon / jest --watch\n" +
          "- 任何不会自动退出、需要持续运行的进程\n" +
          "⚠️ 这类命令绝不能用 execute_command——它会同步等进程退出，导致卡死直到超时。\n\n" +
          "【返回】立即返回 terminalId（进程句柄）。之后用 get_process_output 看启动日志/报错，用 stop_process 停止。\n" +
          "若已有相同命令+目录的进程在跑，会复用它并提示（不重复起服务）。",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "要在后台启动的命令" },
            cwd: { type: "string", description: "工作目录（绝对路径），默认终端当前目录" },
          },
          required: ["command"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "get_process_output",
        description:
          "读取某个后台进程（start_process 启动的）的累积输出与运行状态。\n" +
          "用于确认开发服务器是否启动成功、监听到哪个端口、有没有报错。返回 status（running/exited/stopped）与输出。",
        parameters: {
          type: "object",
          properties: {
            terminalId: { type: "string", description: "start_process 返回的进程句柄 id" },
            lines: { type: "number", description: "仅返回最近 N 行输出（可选，用于控制篇幅）。省略则返回全部缓冲" },
          },
          required: ["terminalId"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "stop_process",
        description: "终止某个后台进程（start_process 启动的）并回收资源。用完开发服务器/watch 后应停掉。",
        parameters: {
          type: "object",
          properties: {
            terminalId: { type: "string", description: "start_process 返回的进程句柄 id" },
          },
          required: ["terminalId"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "list_processes",
        description: "列出当前所有由 start_process 启动的后台进程及其状态（terminalId、命令、目录、running/exited/stopped）。",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "open_browser",
        description:
          "用真实浏览器打开（或导航到）一个 URL——通常是 start_process 启动的开发服务器地址（如 http://localhost:5173）。\n" +
          "打开后浏览器会持续运行并记录控制台日志、未捕获异常、失败的网络请求。配合 get_browser_logs 看前端运行时报错、screenshot_page 看页面长相，形成「改代码→看报错→确认」的闭环。\n" +
          "已打开则复用同一浏览器并导航过去（不重复开窗）。",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "要打开的完整 URL，必须以 http:// 或 https:// 开头" },
          },
          required: ["url"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "get_browser_logs",
        description:
          "读取当前浏览器页面累积的【控制台日志 / 未捕获异常 / 失败网络请求（含 4xx/5xx）】。\n" +
          "用于判断前端是否真的跑起来、有没有 JS 报错、接口是否 404/500。改完前端代码后调它确认运行时无错。",
        parameters: {
          type: "object",
          properties: {
            clear: { type: "boolean", description: "读取后是否清空缓冲（默认 false）。改代码前清一次、改完再读，能只看到本次新增的报错" },
          },
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "screenshot_page",
        description:
          "对当前浏览器页面截图，截图会作为图片提供给你查看页面实际渲染效果（需当前模型支持看图）。\n" +
          "用于确认布局/样式/内容是否符合预期。仅靠控制台日志看不出视觉问题时用它。",
        parameters: {
          type: "object",
          properties: {
            fullPage: { type: "boolean", description: "是否整页截图（默认 false，只截当前可视区域）" },
          },
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "close_browser",
        description: "关闭由 open_browser 打开的浏览器并回收资源。前端调试结束后调用。",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "browser_click",
        description:
          "点击浏览器页面上的元素。selector 支持 CSS 选择器或 Playwright 文本选择器（如 'text=登录'、'button:has-text(\"提交\")'）。\n" +
          "用法：配合 screenshot_page 先看到页面结构，然后对目标元素 click。点击后可再 screenshot_page 确认效果。",
        parameters: {
          type: "object",
          properties: {
            selector: { type: "string", description: "目标元素的 CSS 选择器或 Playwright 文本选择器" },
          },
          required: ["selector"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "browser_type",
        description:
          "在页面输入框中填入文本（先清空再输入）。用于表单填写、搜索框输入等。\n" +
          "selector 定位到 input/textarea 元素；text 为要输入的内容。",
        parameters: {
          type: "object",
          properties: {
            selector: { type: "string", description: "输入框的 CSS 选择器（如 '#username'、'input[name=\"email\"]'）" },
            text: { type: "string", description: "要输入的文本" },
          },
          required: ["selector", "text"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "browser_press",
        description: "模拟键盘按键。用于按 Enter 提交表单、Tab 切换焦点、Escape 关闭弹窗等。",
        parameters: {
          type: "object",
          properties: {
            key: { type: "string", description: "按键名（如 'Enter'、'Tab'、'Escape'、'Backspace'）" },
          },
          required: ["key"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "browser_select",
        description: "选择下拉框（<select>）的选项。value 为 option 的 value 属性值。",
        parameters: {
          type: "object",
          properties: {
            selector: { type: "string", description: "select 元素的 CSS 选择器" },
            value: { type: "string", description: "要选中的 option value" },
          },
          required: ["selector", "value"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "browser_scroll",
        description: "滚动浏览器页面。用于看到页面下方/上方的内容（当前视口看不全时）。",
        parameters: {
          type: "object",
          properties: {
            direction: { type: "string", enum: ["up", "down", "top", "bottom"], description: "滚动方向：up(上滚一屏)/down(下滚一屏)/top(滚到顶)/bottom(滚到底)" },
          },
          required: ["direction"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "browser_reload",
        description: "刷新当前浏览器页面。改完代码后刷新看最新效果（HMR 不生效时手动刷新）。",
        parameters: {
          type: "object",
          properties: {},
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "get_browser_network",
        description:
          "读取浏览器的网络请求记录（等同 F12 Network 面板）。支持按 URL/方法/状态码/资源类型过滤，避免返回过多内容。\n" +
          "不传过滤条件时返回最近 50 条。建议按需精确查询（如只看 API 请求用 urlContains=\"/api\"，只看失败的用 statusMin=400）。\n" +
          "每条包含：method、url、status、resourceType（xhr/fetch/script/stylesheet/image/font/document 等）、duration(ms)、size(bytes)。",
        parameters: {
          type: "object",
          properties: {
            urlContains: { type: "string", description: "URL 包含此子串（不区分大小写）" },
            method: { type: "string", description: "HTTP 方法（GET/POST/PUT/DELETE 等）" },
            statusMin: { type: "number", description: "状态码 >= 此值（如 400 只看失败）" },
            statusMax: { type: "number", description: "状态码 <= 此值" },
            resourceType: { type: "string", description: "资源类型（xhr/fetch/document/stylesheet/script/image/font/websocket 等）" },
            limit: { type: "number", description: "最多返回条数（默认 50，最大 200）" },
            clear: { type: "boolean", description: "读取后是否清空缓冲（默认 false）" },
          },
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "get_browser_storage",
        description:
          "读取当前页面的存储数据（等同 F12 Application 面板）。\n" +
          "支持读取 localStorage、sessionStorage 和 cookies。可按 key 子串过滤，避免返回过多内容。\n" +
          "用途：查看登录 token、用户状态、缓存数据、调试认证问题等。",
        parameters: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["localStorage", "sessionStorage", "cookies"], description: "存储类型" },
            keyContains: { type: "string", description: "只返回 key 包含此子串的条目（不区分大小写，可选）" },
          },
          required: ["type"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "browser_eval",
        description:
          "在浏览器页面上下文中执行任意 JavaScript 代码并返回结果。万能兜底——其他浏览器工具覆盖不了的操作都可以用它。\n" +
          "示例：读取某个全局变量、调用页面函数、修改 DOM、mock fetch 等。返回值会被 JSON.stringify 序列化。",
        parameters: {
          type: "object",
          properties: {
            js: { type: "string", description: "要在页面上下文执行的 JavaScript 代码（表达式或语句块）" },
          },
          required: ["js"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "browser_hover",
        description: "悬停在页面指定元素上（触发 tooltip、下拉菜单、hover 效果等）。悬停后可 screenshot_page 看效果。",
        parameters: {
          type: "object",
          properties: {
            selector: { type: "string", description: "目标元素的 CSS 选择器或 Playwright 文本选择器" },
          },
          required: ["selector"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "browser_wait",
        description:
          "等待页面状态就绪：等某个元素出现、或等待固定时间。用于点击/导航后等异步加载完成再截图，避免截到中间态。",
        parameters: {
          type: "object",
          properties: {
            selector: { type: "string", description: "等待该 CSS 选择器的元素出现在 DOM 中（可选）" },
            ms: { type: "number", description: "等待固定毫秒数（可选，最大 30000）。与 selector 同时传时先等元素再等时间" },
          },
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "browser_get_html",
        description:
          "读取页面指定区域的 HTML 源码（比截图更精确、不费多模态 token）。\n" +
          "不传 selector 时读取整个 body。用于获取 DOM 结构、检查元素属性/类名等。",
        parameters: {
          type: "object",
          properties: {
            selector: { type: "string", description: "目标元素的 CSS 选择器（可选，不传读整个 body）" },
          },
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "browser_set_viewport",
        description: "设置浏览器视口大小（测试响应式布局/移动端适配）。设置后可 screenshot_page 看效果。",
        parameters: {
          type: "object",
          properties: {
            width: { type: "number", description: "视口宽度（px）" },
            height: { type: "number", description: "视口高度（px）" },
          },
          required: ["width", "height"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "browser_back",
        description: "浏览器后退（等同点击后退按钮）。",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "browser_forward",
        description: "浏览器前进（等同点击前进按钮）。",
        parameters: { type: "object", properties: {} },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "search",
        description: `在项目中搜索。mode=content 按内容搜索（类似 grep，返回匹配行及前后各1行上下文）；mode=file 按文件名搜索；mode=dir 按目录名搜索。自动跳过 node_modules、.git 等目录。注意：search 需要明确的关键词，不接受 '*' 这类通配符；想了解目录里有哪些文件请改用 list_dir。

搜索策略（重要）：
- query 支持正则。搜不精确时用 | 做 OR 扩展范围，如 "getFoo|fetchFoo|queryFoo"（仅示意 OR 写法，实际请用真实标识符）
- 用 includePattern 缩窄文件类型（如 ".kt" 只搜 Kotlin），大幅减少噪音和耗时
- 第一次没命中时：换同义词/缩写/中英文互换重搜，不要直接去 read_file 碰运气
- 优先搜索定位再精确读取，不要先读大文件再人肉找目标`,
        parameters: {
          type: "object",
          properties: {
            intent: { type: "string", description: "用一句简短的自然语言说明本次搜索的【目的】，展示给用户（如\"查找权限校验逻辑\"）。只写目的，不要把你猜测的函数名/变量名列进来（如不要写\"查找权限校验逻辑（如 checkPermission、hasPermission）\"）——那些猜测词放进 query 参数去搜，不要暴露在 intent 里" },
            query: { type: "string", description: "搜索关键词（content 模式支持正则，可用 | 做 OR 匹配多个关键词；file/dir 模式为名称子串）" },
            mode: { type: "string", enum: ["content", "file", "dir"], description: "搜索模式，默认 content" },
            path: { type: "string", description: "搜索范围目录，默认工作根目录" },
            includePattern: { type: "string", description: "仅搜索匹配此后缀的文件，如 '.kt' 或 '.py'（content 模式可用，强烈建议指定以缩小范围）" },
          },
          required: ["intent", "query"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "list_dir",
        description: "列出目录结构（树形展示），用于了解项目/某个目录里有哪些文件和子目录。自动跳过 node_modules、.git 等目录。到达 depth 上限仍有内容的目录会标记 \"(未展开)\"——如果没找到目标，可对该子目录单独再调一次 list_dir 或加大 depth，也可以改用 search 精确定位",
        parameters: {
          type: "object",
          properties: {
            intent: { type: "string", description: "用一句简短的自然语言说明本次的目的（如\"了解项目整体结构\"），将展示给用户" },
            path: { type: "string", description: "要列出的目录，默认工作根目录" },
            depth: { type: "number", description: "递归层数，默认 2，最大 3" },
          },
          required: ["intent"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "check_diagnostics",
        description: "对你刚刚修改/创建过的文件做类型检查（TypeScript 项目用 tsc --noEmit）。一次可传多个文件，会按文件分别返回诊断结果：每个文件标明'无错误'或具体的错误行号与原因。修改完代码后调用它确认没有引入编译/类型错误。注意：一次把本轮改动过的所有文件一起传进来，不要一个文件调一次。必须明确指定要检查的文件路径，禁止传空数组。",
        parameters: {
          type: "object",
          properties: {
            paths: {
              type: "array",
              items: { type: "string" },
              description: "要检查的文件路径数组（相对工作区）。必须传入本轮修改/创建过的文件，不能为空。禁止不传文件做全项目检查。",
              minItems: 1,
            },
          },
          required: ["paths"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "web_search",
        description: "联网搜索：查询最新信息、文档、技术方案等。当你需要当前信息（最新版本号、API 文档、错误解决方案、时事新闻）或知识不确定时使用。返回最多 10 条相关结果（标题、URL、摘要）。",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "搜索查询词（简洁、关键词化，200 字符以内）" },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "web_fetch",
        description: "抓取指定网页的正文内容并提取为纯文本。用于深入读取某个具体 URL 的内容（如 web_search 命中的结果页、用户给出的文档链接）。url 必须是以 http:// 或 https:// 开头的完整地址。注意：JS 渲染的 SPA 页面可能抓不到有效正文，这种情况改用 web_search 查找替代信息源。",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "要抓取的网页完整地址，必须以 http:// 或 https:// 开头" },
          },
          required: ["url"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "use_skill",
        description:
          "加载一个技能（skill）的完整说明书到你当前的上下文，然后你自己按说明书执行任务。\n\n" +
          "【与 delegate_task 的区别】\n" +
          "- use_skill：技能说明加载进【你自己】的上下文，由你直接执行。轻量、过程对用户可见、不开新 agent。\n" +
          "- delegate_task：把任务连同技能交给【隔离的子 agent】执行，你只拿到最终结论。重、适合大型独立任务。\n\n" +
          "【何时用 use_skill】\n" +
          "- 任务匹配某个可用 skill 的触发场景，且适合你在当前对话里直接一步步做\n" +
          "- 你只是想参考某个 skill 的步骤/规范来指导接下来的操作\n\n" +
          "加载后请严格按返回的技能说明执行。技能列表见系统提示中列出的可用技能。",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "要加载的 skill 名称（来自系统提示中列出的可用技能）" },
          },
          required: ["name"],
        },
      },
    },
    {
      type: "function" as const,
      function: {
        name: "activate_power",
        description:
          "激活一个 Power 能力包，加载其文档、MCP 服务器配置和捆绑的 Skills 清单到当前上下文。\n\n" +
          "【何时激活】\n" +
          "- 当用户的请求匹配某个已安装 Power 的关键词（keywords）时，主动激活\n" +
          "- 当用户明确提到某个 Power 的名称时\n" +
          "- 当你需要使用某个 Power 提供的工具或方法论时\n\n" +
          "【激活后】\n" +
          "- 你会获得：Power 的完整文档（POWER.md）、MCP 服务器列表及其工具描述、捆绑的 Skills 列表\n" +
          "- 根据返回信息决定后续操作：use_skill 加载捆绑的 Skill、或使用 MCP 提供的工具\n" +
          "- 一个会话内同一个 Power 只需激活一次，不要重复激活\n\n" +
          "已安装的 Powers 见系统提示中列出的可用 Power 清单。",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "要激活的 Power 名称（来自系统提示中列出的可用 Power）" },
          },
          required: ["name"],
        },
      },
    },
  ];
}

/**
 * 只读工具白名单：不改文件、不执行命令，可安全地多个子 Agent 并行调用。
 */
export const READ_ONLY_TOOL_NAMES = new Set([
  "read_file",
  "search",
  "list_dir",
  "web_search",
  "web_fetch",
  "use_skill",
  "activate_power",
]);

/** 返回只读工具定义子集，供并行调研子 Agent 使用（不写盘、不跑命令）。 */
export function getReadOnlyToolDefinitions() {
  return getToolDefinitions().filter((t) => READ_ONLY_TOOL_NAMES.has(t.function.name));
}

/** check_diagnostics 的结构化结果：每个文件一条，供前端折叠展示 */
export interface DiagnosticFileResult {
  path: string;
  ok: boolean;
  errorCount: number;
  /** 结果作用域：'project' 表示整个项目的汇总结果（非单个文件）。缺省为文件级。 */
  scope?: 'project';
}

/**
 * 工具执行失败时携带【两份文案】的错误：
 * - message（父类 Error.message）：给 AI 看的详细版，含具体原因、纠错步骤、可提工具名，进对话历史喂模型纠错
 * - userMessage：给用户看的简短版，一句话说清「发生了什么」，不暴露内部工具名/机制，供前端失败卡片展示
 * 普通 Error（未区分两份）时，前端回退到对详细 message 的截断展示。
 */
export class ToolError extends Error {
  userMessage: string;
  constructor(aiMessage: string, userMessage: string) {
    super(aiMessage);
    this.name = "ToolError";
    this.userMessage = userMessage;
  }
}

/** 工具执行的附加元数据（如文件修改的完整前后快照、本次实际读取的行范围） */
export interface ToolMeta {
  /** 输入：本次工具调用的 id（= tool_call id），用作编辑单元 editId 的前缀，支持逐次改动接受/拒绝/撤销 */
  editId?: string;
  /** execute_command 专用：命令在终端等待用户输入时回调 */
  onWaitingInput?: () => void;
  fileDiff?: { path: string; absPath?: string; oldContent: string; newContent: string; editId?: string };
  /** apply_patch 等单次调用改多个文件的工具：按文件累计的 diff 列表（fileDiff 仅保留最后一个，向后兼容单文件工具）。 */
  fileDiffs?: { path: string; absPath?: string; oldContent: string; newContent: string; editId?: string }[];
  readRange?: { startLine: number; endLine: number };
  diagnostics?: DiagnosticFileResult[];
  skillUsed?: string;
  /** activate_power 专用：已激活的 Power 信息 */
  powerActivated?: { name: string; displayName: string; mcpServerCount: number; skillCount: number; keywords: string[] };
  /** 工具调用卡片是否对用户隐藏（中性结果：工具试探性调用被拦住，不需要展示给用户）。
   * true 时前端不渲染该卡片，让 AI 的文字回复直接面对用户。 */
  hidden?: boolean;
  /** 隐藏原因（调试/日志用，如「文件已存在」「文件不存在」） */
  hiddenReason?: string;
  searchResults?: unknown;
  fetchResult?: unknown;
  /** 给用户看的简短失败文案（不暴露内部工具名/机制）。失败时由工具填入，前端失败卡片优先展示它 */
  userMessage?: string;
  /** screenshot_page 专用：截图的 data URL（data:image/png;base64,...）。
   *  agent loop 会在工具结果后追加一条带该图片的 user 消息，喂给多模态模型"看"页面。 */
  screenshotDataUrl?: string;
  /** execute_command / start_process 专用：命令执行后终端的实际工作目录 */
  terminalCwd?: string;
}

/** 按工具类型返回“存入对话历史的内容上限（字符）” */
export function toolContentLimit(toolName: string): number {
  switch (toolName) {
    case "read_file":
      return 12_000;
    case "web_fetch":
      return 10_000;
    case "check_diagnostics":
      return 8_000;
    case "search":
    case "list_dir":
      return 4_000;
    default:
      return 3_000;
  }
}

/** Skill 加载器：按名称返回 skill 正文（用于 use_skill 工具）。由上层注入。 */
export type SkillLoaderFn = (name: string) => Promise<{ name: string; dir: string; body: string } | null>;

/** Power 加载器：按名称返回 Power 完整信息（用于 activate_power 工具）。由上层注入。 */
export type PowerLoaderFn = (name: string) => Promise<{
  name: string;
  displayName: string;
  body: string;
  keywords: string[];
  mcpServerCount: number;
  skillCount: number;
  skills: { name: string; description: string }[];
  mcpServers: Record<string, { command: string; args?: string[] }>;
  steeringFiles: string[];
} | null>;
