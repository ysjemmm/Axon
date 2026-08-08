/**
 * ToolDefBuilder —— 工具定义装配（从 AgentSession 解耦）
 *
 * 职责单一：把"通用工具集 + delegate_task + Relay 工具集 + MCP 工具"装配成发给 LLM 的
 * ToolDef[]。delegate_task / relay 工具定义是纯数据（不含会话状态），故意不放进通用 tools.ts：
 * 这样子 Agent 拿不到它们，天然把委托递归限制在 1 层。
 *
 * 通过构造注入的 session 引用读取 mode / questWebSearch / MCP 工具缓存（@internal）。
 */

import type { ToolDef } from "../llm/types.js";
import { getToolDefinitions } from "../tools/index.js";
import type { AgentSession } from "../agentSession.js";

export class ToolDefBuilder {
  constructor(private readonly s: AgentSession) {}

  /** 把 OpenAI Chat 工具定义转成策略层的 ToolDef（主 agent 额外带 delegate_task + relay 工具集） */
  getToolDefs(): ToolDef[] {
    // Quest 模式：禁用所有工具；仅在开启联网时放行 web_search / web_fetch
    if (this.s.mode === "quest") {
      if (!this.s.questWebSearch) return [];
      const base = getToolDefinitions() as unknown as ToolDef[];
      return base.filter((t) => {
        const name = (t as { function?: { name?: string } }).function?.name;
        return name === "web_search" || name === "web_fetch";
      });
    }
    const base = getToolDefinitions() as unknown as ToolDef[];
    return [...base, this.getDelegateToolDef(), ...this.getRelayToolDefs(), ...this.s.mcpToolDefsCache];
  }

  /**
   * delegate_task 工具定义：主 agent 专用，把任务委托给隔离的子 agent 执行。
   * 故意不放进 tools.ts 通用工具集，这样子 agent 拿不到它 → 限制递归只有 1 层。
   */
  private getDelegateToolDef(): ToolDef {
    return {
      type: "function",
      function: {
        name: "delegate_task",
        description:
          "把一个具体任务委托给独立的子 Agent 执行。子 Agent 在隔离上下文中运行（看不到主对话历史），" +
          "完成后只把最终结论返回给你。\n\n" +
          "【核心理念：保护主上下文】\n" +
          "主 Agent 的上下文是稀缺资源。大量中间产物（搜索结果、文件内容、调试输出、多次试错的 trace）" +
          "会撑爆上下文窗口、稀释关键信息、推高每轮 API 成本。委托给子 Agent 可以把这些中间噪音隔离在外，" +
          "你只拿回一段干净的结论摘要。\n\n" +
          "【关键判断标准】\n" +
          "主 Agent 需要知道结论，还是需要知道过程？只需要结论 → 委托。需要基于中间发现做后续决策 → 自己做。\n\n" +
          "【应当委托】\n" +
          "- 排查深层 bug 的根因：子 Agent 搜索 + 读码 + 定位，只返回根因结论和修复建议\n" +
          "- 调研不熟悉的技术方案可行性：子 Agent 联网 + 读码 + 分析，只返回结论\n" +
          "- 大范围重构前的现状摸底：子 Agent 搜全量使用点 + 理清依赖关系，只返回汇总\n" +
          "- 验证复杂函数行为：子 Agent 构造测试用例 + 跑验证，只返回是否通过\n" +
          "- 大范围、可并行的独立检索/调研：结论能压缩成摘要，且不依赖当前对话已有的细节\n\n" +
          "【不应委托】\n" +
          "- 一两步就能完成：读一个文件、改一行代码、跑一条命令（委托开销反而更慢）\n" +
          "- 需要基于结果做即时决策的任务（中间发现会影响下一步行动）\n" +
          "- 强依赖当前对话上下文的任务（子 Agent 看不到对话历史）\n" +
          "- 需要和用户来回确认的交互式任务\n\n" +
          "⚠️ 子 Agent 看不到当前对话历史。委托前请把任务描述写清楚、自包含（包含所有必要的上下文、输入和期望输出）。",
        parameters: {
          type: "object",
          properties: {
            intent: { type: "string", description: "一句话说明本次委托的目的，展示给用户（如\"按用户要求，使用 subagent 计算数学问题\"）" },
            prompt: { type: "string", description: "交给子 Agent 完成的完整任务描述。必须自包含，包含所有必要的上下文、输入和期望输出" },
            skill: { type: "string", description: "可选。要加载的 skill 名称（来自系统提示中列出的可用技能）。匹配到 skill 时务必传入，子 Agent 会加载该 skill 的完整说明执行" },
          },
          required: ["intent", "prompt"],
        },
      },
    };
  }

  /**
   * Relay 长任务工作流的工具集（主 Agent 专用）。
   * 让主 Agent 能把大需求结构化为「需求→设计→计划→执行」的可控流程，
   * 每阶段产出文档落盘、经用户确认门后推进，执行阶段可逐项勾选。
   */
  private getRelayToolDefs(): ToolDef[] {
    return [
      {
        type: "function",
        function: {
          name: "relay_create",
          description:
            "为一个【大任务/复杂需求】启动 Relay 长任务工作流。\n\n" +
            "【何时用】大任务/多文件改动/重构/搭建子系统 → 先建工作流再推进。一两步小任务直接做。\n\n" +
            "【五阶段】brainstorm（需求）→ design（设计）→ plan（计划）→ executing（执行）→ done：\n\n" +
            "1. brainstorm：澄清目标/范围/验收标准（苏格拉底式追问），可用 parallel_research 并行调研 → relay_save_doc(phase=\"brainstorm\") 写 requirements.md，分段呈现确认。\n" +
            "2. design（用户确认后 relay_advance 推进）：架构/模块划分/数据流 → relay_save_doc(phase=\"design\") 写 design.md。\n" +
            "3. plan：拆成小颗粒可独立验证任务清单（2-5min/项），relay_save_doc(phase=\"plan\") 写 plan.md【必须用复选框格式】。\n" +
            "   拆任务铁律：按纵向功能单元拆（导航栏/表单/图表等），严禁按\"HTML一个任务、CSS一个任务\"横切。\n" +
            "4. executing（用户确认后 relay_advance 推进）：逐项 relay_update_task(in_progress) → 实现 → 自测 → relay_review_task 评审 → relay_update_task(completed)，一口气跑完。\n\n" +
            "【执行模式】默认传 strict。创建 Relay 时前端确认条会让用户选择严格模式或全自动模式，并以该选择覆盖 mode 参数；不要在对话里额外询问模式偏好。\n" +
            "- strict：每阶段写完文档后停下等用户确认再推进。\n" +
            "- auto：全自动推进，不等每阶段确认。\n\n" +
            "【评审门】只有 critical 级别问题才阻断任务完成，major/minor 作为建议不阻断。\n" +
            "【连续执行】进入 executing 后连续推进所有任务，仅评审打回/环境阻塞/全部完成时停下。\n" +
            "【parallel_research】并发布多个只读子 Agent 调研互不依赖的子问题。\n\n" +
            "【模型选择】默认所有阶段和评审都用当前会话模型。仅当用户明确提出\"评审用更强的模型\"" +
            "\"执行阶段换个便宜模型\"等诉求时，才通过 modelOverrides 参数为对应环节指定模型，不要主动询问。",
          parameters: {
            type: "object",
            properties: {
              title: { type: "string", description: "任务标题（简短，作为 relay 标识，如\"用户登录功能\"）" },
              summary: { type: "string", description: "一句话目标摘要" },
              mode: { type: "string", enum: ["strict", "auto"], description: "执行模式：默认 strict；用户可在创建 Relay 的前端确认条中选择 strict 或 auto，选择会覆盖此值" },
              tdd: { type: "boolean", description: "是否强制 TDD（先写失败测试→实现→测试通过）。默认 false。用户明确要求测试驱动时设 true" },
              review: { type: "boolean", description: "是否启用两阶段评审（规格符合性+代码质量）。默认 true，强烈建议保持开启" },
              modelOverrides: {
                type: "object",
                description:
                  "可选：为执行/评审环节单独指定模型（不填则回退到当前会话模型）。仅 executing 和 review 两个 key 生效" +
                  "（brainstorm/design/plan 由主对话直接生成，暂不支持独立模型）。value 为模型 id（如 \"gpt-5.5\"）。" +
                  "用户明确要求某环节用别的模型时才填，否则整个字段省略。",
                properties: {
                  executing: { type: "string", description: "执行阶段（子 Agent 实现任务）使用的模型 id" },
                  review: { type: "string", description: "两阶段评审使用的模型 id" },
                },
              },
            },
            required: ["title", "summary"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "relay_save_doc",
          description:
            "把当前阶段的产出文档写入 Relay。phase 取值：\n" +
            "- brainstorm → 写 requirements.md（需求文档：用户故事、验收标准、范围边界）\n" +
            "- design → 写 design.md（设计文档：架构、模块划分、关键决策、数据流）\n" +
            "- plan → 写 plan.md（任务计划：必须用 Markdown 复选框清单，每项带层级编号、涉及文件、验证方式）\n\n" +
            "⚠️ plan.md 的任务清单格式（会被解析成可勾选任务，务必遵守）：\n" +
            "- [ ] 1. 顶层任务标题\n" +
            "  - [ ] 1.1 子任务，说明涉及哪些文件、怎么验证\n" +
            "- [ ] 2. 下一个任务\n\n" +
            "写完文档后把要点简洁呈现给用户。strict 模式等用户确认再推进；auto 模式可直接推进。",
          parameters: {
            type: "object",
            properties: {
              id: { type: "string", description: "relay id（relay_create 返回）" },
              phase: { type: "string", enum: ["brainstorm", "design", "plan"], description: "产出文档对应的阶段" },
              content: { type: "string", description: "完整的 Markdown 文档正文" },
            },
            required: ["id", "phase", "content"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "relay_advance",
          description:
            "在用户【明确确认】当前阶段产物后，把 Relay 推进到下一阶段（这是确认门 checkpoint）。\n" +
            "阶段流转：brainstorm → design → plan → executing → done。\n" +
            "⚠️ 必须等用户表达了认可（如\"可以\"\"通过\"\"继续\"）才调用，不要自作主张跨阶段推进。",
          parameters: {
            type: "object",
            properties: {
              id: { type: "string", description: "relay id" },
              phase: { type: "string", enum: ["brainstorm", "design", "plan", "executing"], description: "用户已确认通过的当前阶段" },
            },
            required: ["id", "phase"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "relay_update_task",
          description:
            "更新 Relay 执行阶段中某个任务的状态（开始执行设 in_progress，完成设 completed）。\n" +
            "会自动回写 plan.md 的复选框并同步前端进度。一次只推进一个任务：开始前设 in_progress，" +
            "做完并验证后设 completed，再进入下一个任务。全部完成后 relay 自动进入 done。",
          parameters: {
            type: "object",
            properties: {
              id: { type: "string", description: "relay id" },
              taskId: { type: "string", description: "任务编号（如 \"1\"、\"1.2\"，与 plan.md 复选框前缀一致）" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"], description: "新状态" },
            },
            required: ["id", "taskId", "status"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "relay_review_task",
          description:
            "对一个刚完成实现的 Relay 任务发起【两阶段评审】（仅在 relay 启用了 review 时用）：\n" +
            "- 第一阶段规格符合性：改动是否真的满足任务卡 + 需求/设计，有没有跑偏/漏做/假实现\n" +
            "- 第二阶段代码质量：坏味道、重复、边界处理、是否破坏现有逻辑\n\n" +
            "评审由独立的【只读】子 Agent 执行。任一阶段发现 critical 问题会判定不通过，" +
            "此时你要按返回的反馈【修复代码】后再次调用本工具重审，不要带病把任务标记完成。\n" +
            "评审通过后再用 relay_update_task 把任务标记 completed。\n\n" +
            "调用时机：你完成某个任务的代码实现、自测通过后，标记 completed【之前】调用。",
          parameters: {
            type: "object",
            properties: {
              id: { type: "string", description: "relay id" },
              taskId: { type: "string", description: "刚完成实现的任务编号" },
            },
            required: ["id", "taskId"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "parallel_research",
          description:
            "把一个大调研拆成若干【相互独立】的子问题，同时派发多个【只读】子 Agent 并发探索，最后汇总结论。\n\n" +
            "【何时用】需要在大范围内并行检索/调研、且各子问题互不依赖时（如\"分别摸清前端路由、后端鉴权、数据库schema三块的现状\"）。" +
            "尤其适合 Relay 的 brainstorm/design 阶段快速摸清现状。\n\n" +
            "【限制】子 Agent 只读：只能读文件/搜索/列目录/联网，不能改文件或执行命令。需要动手改代码用 delegate_task 或自己做。\n\n" +
            "【不要用】子问题之间有依赖、需要顺序推进的，或只有一个调研点的（那直接自己查或用 delegate_task）。",
          parameters: {
            type: "object",
            properties: {
              intent: { type: "string", description: "一句话说明本次并行调研的总目的，展示给用户" },
              tasks: {
                type: "array",
                description: "并行调研的子任务列表（2~5 个为宜，每个互相独立）",
                items: {
                  type: "object",
                  properties: {
                    intent: { type: "string", description: "该子任务的一句话目的" },
                    prompt: { type: "string", description: "交给只读子 Agent 的完整调研描述，必须自包含" },
                  },
                  required: ["intent", "prompt"],
                },
              },
            },
            required: ["intent", "tasks"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "parallel_execute",
          description:
            "把一个大实现任务拆成若干【互不依赖、文件不重叠】的子任务，同时派发多个子 Agent 并行执行，各自改代码。\n\n" +
            "【何时用】需求可以明确拆成多个互不依赖的修改（如\"前端加登录页 + 后端加 auth API + 写集成测试\"），" +
            "且各子任务操作的文件不重叠时。适合 Relay 的 executing 阶段加速并行任务。\n\n" +
            "【关键约束】每个子任务必须声明 fileScope（允许修改的文件/目录 glob），不同子任务的 fileScope 不能重叠。" +
            "越界写入会被系统拦截。\n\n" +
            "【不要用】子任务之间有代码依赖（如 B 要 import A 的产出）、或文件修改范围有交叉的，用串行 delegate_task。",
          parameters: {
            type: "object",
            properties: {
              intent: { type: "string", description: "一句话说明本次并行执行的总目标，展示给用户" },
              tasks: {
                type: "array",
                description: "并行执行的子任务列表（2~5 个为宜，每个文件作用域互不重叠）",
                items: {
                  type: "object",
                  properties: {
                    intent: { type: "string", description: "该子任务的一句话目的" },
                    prompt: { type: "string", description: "交给子 Agent 的完整实现指令，必须自包含（含背景、目标、验收标准）" },
                    fileScope: {
                      type: "array",
                      description: "允许该子 Agent 修改的文件/目录 glob 列表（如 [\"src/pages/login/**\", \"src/components/LoginForm.tsx\"]）",
                      items: { type: "string" },
                    },
                  },
                  required: ["intent", "prompt", "fileScope"],
                },
              },
            },
            required: ["intent", "tasks"],
          },
        },
      },
    ];
  }
}
