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
import { getToolDefinitions, ToolName } from "../tools/index.js";
import type { AgentSession } from "../agentSession.js";
import type { ToolGroup } from "./toolLoadout.js";

export class ToolDefBuilder {
  constructor(private readonly s: AgentSession) {}

  /**
   * 本轮发给模型的工具：全量清单经按需加载过滤（不常用的工具组未加载时只留 load_tools 里的索引，
   * 见 toolLoadout.ts）。Quest 模式的主要交付就是产物，产物组常驻。
   */
  getToolDefs(): ToolDef[] {
    const all = this.getAllToolDefs();
    const groups = this.toolGroups(all);
    this.s.toolLoadout.hydrate(this.s.messages, groups);
    return this.s.toolLoadout.apply(all, groups);
  }

  /** 当前可按需加载的工具组 */
  toolGroups(all: ToolDef[] = this.getAllToolDefs()): ToolGroup[] {
    return this.s.toolLoadout.groups(all, this.s.mcpToolMap, this.s.mode === "quest" ? ["artifact"] : []);
  }

  /** 全量工具清单（主 agent 额外带 delegate_task + relay 工具集） */
  getAllToolDefs(): ToolDef[] {
    // Quest 模式：不给读写/命令等「动仓库」的工具；但 ask_user（选项问答）是纯交互、不碰仓库，
    // 问答场景同样需要它（让 AI 抛选项、用户点选作答），故始终放行；联网工具按开关放行。
    if (this.s.mode === "quest") {
      // Quest 是纯问答，只保留 ask_user 这个「抛选项让用户点选」的交互能力。
      // ask_form（让用户填一套参数/表格）属于"开工前收集输入"，是 Agent 形态的诉求，
      // 纯问答里没有使用场景，故不注入。
      const tools: ToolDef[] = [this.getAskUserToolDef()];
      // 产物不碰仓库（后端直接写到产物目录），问答模式同样可以交付 HTML 页面、SVG、文档。
      // 局部修改与读回也只在产物目录内：改一处不必整份重写，压缩 / 分叉后也能读回原文。
      tools.push(this.getCreateArtifactToolDef(), this.getEditArtifactToolDef(), this.getReadArtifactToolDef());
      // 技能 / Power 目录里的附属文件（模板、参考资料）：问答模式没有 read_file，不给就读不到
      tools.push(this.getReadSkillFileToolDef());
      // 会话记忆只改会话自己的一个字段，不碰仓库；问答模式同样有记忆面板和记忆注入
      tools.push(this.getUpdateMemoryToolDef(), this.getUpdateTasksToolDef());
      // 技能与能力包：只读取方法论文本、不碰仓库（两者在 catalog 里都标了 readOnly），
      // 所以问答模式同样要能把清单里的东西真正加载进来——否则提示里列了 name，
      // 模型却调不了 use_skill / activate_power，等于清单是死的。
      // 注意 Quest 没有 delegate_task，use_skill 是唯一入口（技能清单文案里会据此收敛说法）。
      tools.push(...this.pickBaseToolDefs(ToolName.UseSkill, ToolName.ActivatePower));
      // MCP：由用户自己配置的外部能力，本身不碰仓库，且非 autoApprove 的调用会走确认门。
      // 缓存为空时（没配 server / 预取失败）自然不注入。
      if (this.s.mcpToolDefsCache.length > 0) tools.push(...this.s.mcpToolDefsCache);
      // 动画渲染：只在宿主真能渲染时才给，否则模型会调一个必然失败的工具。
      // 它不碰仓库、不给模型命令权限（渲染流程固定封在宿主里），所以问答模式也可以用。
      // 动画渲染：既要宿主有这个能力，也要用户在设置里明确开启。
      // 默认不开启时不注入工具——模型看不到就不会反复尝试，也不会触发组件下载。
      if (this.s.mediaEnabled && this.s.host?.mediaRenderer) tools.push(this.getRenderMediaToolDef());
      // 文生图：和动画渲染一样，能力来自宿主（需配置生图服务），未配置时不注入。
      if (this.s.imageEnabled && this.s.host?.imageGenerator) tools.push(this.getGenerateImageToolDef());
      if (this.s.questWebSearch) {
        tools.push(...this.pickBaseToolDefs(ToolName.WebSearch, ToolName.WebFetch));
      }
      return tools;
    }
    const base = getToolDefinitions() as unknown as ToolDef[];
    const tools = [...base, this.getDelegateToolDef(), this.getAskUserToolDef(), this.getAskFormToolDef(), ...this.getRelayToolDefs(), ...this.s.mcpToolDefsCache];
    tools.push(this.getUpdateMemoryToolDef(), this.getUpdateTasksToolDef());
    tools.push(this.getCreateArtifactToolDef(), this.getEditArtifactToolDef(), this.getReadArtifactToolDef());
    if (this.s.imageEnabled && this.s.host?.imageGenerator) tools.push(this.getGenerateImageToolDef());
    // Cowork：额外给一个「交付产出」工具，让 Agent 自己说清做出了什么文件。
    // 只在办公面板注入 —— Chat/Code 那侧有工具卡片和 diff，不需要再多一个上报动作。
    if (this.s.humanizedStatus) tools.push(this.getDeliverToolDef(), this.getReportChecksToolDef());
    return tools;
  }

  /**
   * 从公共工具定义里按名字挑选。
   * Quest 用它只放行「只读、不碰仓库」的那几项（技能 / 能力包 / 联网），
   * 而不是整份 getToolDefinitions()——后者含读写、命令、浏览器等，问答模式不得触及。
   */
  private pickBaseToolDefs(...names: string[]): ToolDef[] {
    return (getToolDefinitions() as unknown as ToolDef[]).filter((t) => {
      const n = (t as { function?: { name?: string } }).function?.name;
      return n ? names.includes(n) : false;
    });
  }

  /** update_tasks：多步任务的进度清单，每次传完整清单（见 session/taskList.ts） */
  private getUpdateTasksToolDef(): ToolDef {
    return {
      type: "function",
      function: {
        name: "update_tasks",
        description:
          "维护这次任务的进度清单，用户会在对话里实时看到勾选进度。每次传【完整清单】（不是增量），整份替换上一版。\n\n" +
          "【什么时候用】任务需要 3 步以上、或用户一次给了多件事时，开工前先建清单；单步小改、纯问答不要建。\n" +
          "【怎么维护】开始某一项之前把它标为 in_progress（同一时间只有一项 in_progress）；做完立刻标 completed，不要攒到最后一起勾；" +
          "过程中发现新的必要步骤就加进去，不再需要的直接删掉；没做完或失败的不要标 completed。\n" +
          "【标题】祈使句、具体到能看出做什么，例如「修复登录态过期后的跳转」，不要「第一步」这种。\n\n" +
          "更新后不要在回复里复述清单，界面已经展示了。需要需求 / 设计文档、要跨会话推进的大功能用 Relay，不用这个。",
        parameters: {
          type: "object",
          properties: {
            tasks: {
              type: "array",
              description: "完整的任务清单（按执行顺序）",
              items: {
                type: "object",
                properties: {
                  title: { type: "string", description: "任务标题（祈使句）" },
                  status: { type: "string", enum: ["pending", "in_progress", "completed"] },
                },
                required: ["title", "status"],
              },
            },
          },
          required: ["tasks"],
        },
      },
    };
  }

  /** update_memory：增量维护会话记忆；保留 content 以兼容旧模型和整份 Markdown 导入。 */
  private getUpdateMemoryToolDef(): ToolDef {
    return {
      type: "function",
      function: {
        name: "update_memory",
        description:
          "增量维护本次会话里【值得跨会话带走】的记忆，不要每次重写整份 Markdown。\n\n" +
          "【什么时候写】用户交代了长期有效的偏好或约束、敲定了重要设计决策、" +
          "形成了工作区理解、完成了关键改动、留下了待办或踩坑经验时。\n" +
          "不要记录寒暄、一次性中间过程或能直接从源码读取的普通事实。\n\n" +
          "【推荐格式】传 updates 数组，每个元素包含 action（upsert/append/delete）、稳定 key、" +
          "section、title 和 Markdown content。upsert 更新同一知识块，append 追加新条目，delete 删除过时块。\n\n" +
          "【兼容格式】content 仍可传完整 Markdown，表示明确要求整体替换；正常情况下不要使用 content。\n\n" +
          "更新后不要在回复里复述记忆正文，用户可以在记忆面板查看。",
        parameters: {
          type: "object",
          properties: {
            updates: {
              type: "array",
              description: "推荐：要合并的记忆块更新数组。每个元素包含 action、key、section、title、content。",
              items: {
                type: "object",
                properties: {
                  action: { type: "string", enum: ["upsert", "append", "delete"] },
                  key: { type: "string", description: "稳定的知识块 key，例如 neutral-tool-icons" },
                  section: { type: "string", enum: ["project", "workspace", "decisions", "preferences", "status", "pitfalls", "todos", "other"] },
                  title: { type: "string" },
                  content: { type: "string", description: "该知识块的 Markdown 内容" },
                },
                required: ["action", "key"],
              },
            },
            content: { type: "string", description: "兼容模式：完整 Markdown，整份替换现有记忆；正常更新不要使用" },
          },
          required: [],
        },
      },
    };
  }

  /**
   * create_artifact 工具定义（Chat 产物）。
   *
   * 描述里把「什么算产物、什么不算」写得很具体，是因为这个工具的失败模式是被滥用：
   * 模型一旦觉得「生成文件 = 产物」，就会把每一次改源码、每一段几行的代码片段都做成卡片，
   * 聊天界面会被刷满。所以边界要在描述里卡死：独立、完整、用户会想单独打开/保存/复用的东西才算。
   */
  private getCreateArtifactToolDef(): ToolDef {
    return {
      type: "function",
      function: {
        name: "create_artifact",
        description:
          "把你为用户做出来的【一份独立成品】交付出去，界面会把它显示成可点击预览的卡片，并保存到产物目录。\n\n" +
          "⚠️ 两种模式都用它：问答模式和 Agent / Code 模式一样，交付成品的入口只有这一个。" +
          "在 Agent 模式里也**不要**用 create_file 把成品新建到仓库中——那是改项目源码的方式，成品不是项目文件。\n\n" +
          "【适合做成产物】用户会想单独打开、保存、复用或分享的完整内容：\n" +
          "- 可运行的网页 / 交互原型 / 小工具（type=html，写成完整的单文件，样式和脚本内联）\n" +
          "- 图标 / 插画 / 示意图（type=svg）\n" +
          "- 成篇的文档：报告、方案、README、文章（type=markdown）\n" +
          "- 独立完整的脚本或代码文件（type=code，同时传 language）\n" +
          "- 其他纯文本成品，如配置、清单、模板（type=text）\n\n" +
          "【不要做成产物】\n" +
          "- 对项目源码的修改（那是 create_file / str_replace 的事，有专门的改动审阅）\n" +
          "- 几行的代码片段、命令、示例——直接在回复里用代码块给出\n" +
          "- 对话式的解释、分析、列表\n" +
          "- 流程图 / 时序图——用 ```mermaid axon-render 直接画在回复里\n\n" +
          "【使用要求】content 必须是完整内容，不能用“省略其余部分”之类的占位；" +
          "一次调用只交付一份产物，需要多份就分别调用。" +
          "调用成功后回复里不必再贴一遍全文，简短说明它是什么、怎么用即可。\n\n" +
          "【修改已有产物】重新调用本工具、传入修改后的完整内容；同名标题会自动保存为新版本，旧版本不会被覆盖。",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "产物标题，简短、能看出是什么（如“登录页原型”）。会用作文件名，不要带路径或扩展名。" },
            type: { type: "string", enum: ["html", "svg", "markdown", "code", "text"], description: "产物类型，决定保存的扩展名和预览方式" },
            content: { type: "string", description: "产物的完整内容" },
            language: { type: "string", description: "仅 type=code 时填写：编程语言，如 python / typescript / bash。决定保存的扩展名。" },
          },
          required: ["title", "type", "content"],
        },
      },
    };
  }

  /** edit_artifact：在已有产物上做局部修改，存成新版本 */
  private getEditArtifactToolDef(): ToolDef {
    return {
      type: "function",
      function: {
        name: "edit_artifact",
        description:
          "修改一份已经交付的文本产物（html / svg / markdown / code / text）：只提交要改的片段，不用整份重写。\n\n" +
          "【什么时候用】用户要在已有产物上调整（改颜色、加一个按钮、修一段文字、修 bug），改动是局部的。" +
          "改动超过一半、或要换一种结构时，直接用 create_artifact 重新交付更合适。\n\n" +
          "【怎么用】path 传产物的绝对路径（create_artifact / read_artifact 的返回里有）；edits 是若干 { oldStr, newStr }，" +
          "按顺序应用。oldStr 必须与产物当前内容逐字符一致（含空格缩进换行）并且只出现一次，带几行上下文使它唯一。" +
          "手里没有产物的最新原文（压缩之后、换了会话、或用户在别处改过）就先用 read_artifact 读一下。\n\n" +
          "【结果】存成新版本（report-v2.html 这样），旧版本保留；界面显示新版本卡片，回复里简短说明改了什么即可。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "要修改的产物绝对路径" },
            edits: {
              type: "array",
              description: "按顺序应用的修改",
              items: {
                type: "object",
                properties: {
                  oldStr: { type: "string", description: "产物里原样存在、且只出现一次的一段文本" },
                  newStr: { type: "string", description: "替换成的文本（删除就传空串）" },
                },
                required: ["oldStr", "newStr"],
              },
            },
            title: { type: "string", description: "可选：卡片标题，不填沿用原文件名" },
          },
          required: ["path", "edits"],
        },
      },
    };
  }

  /** read_artifact：列出 / 读取产物目录里的产物 */
  private getReadArtifactToolDef(): ToolDef {
    return {
      type: "function",
      function: {
        name: "read_artifact",
        description:
          "读取已交付产物的当前内容，或列出本会话产物目录里有哪些产物。\n" +
          "不带 path：列出产物目录（文件路径与大小）；带 path：返回该产物的完整文本。\n" +
          "要修改一份产物、但上下文里已经没有它的原文时（压缩之后、换了会话、用户说「改一下上次那个页面」）先读一下，再用 edit_artifact 改。" +
          "上下文里已有最新原文就不必再读。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "可选：产物绝对路径；不传则列出产物目录" },
          },
          required: [],
        },
      },
    };
  }

  /** read_skill_file：读技能 / Power 目录里的附属文件 */
  private getReadSkillFileToolDef(): ToolDef {
    return {
      type: "function",
      function: {
        name: "read_skill_file",
        description:
          "读取技能或 Power 目录里的附属文件：模板、参考资料、示例、规范。传目录则列出其中的文件。\n" +
          "加载的技能说明里提到「参考 templates/xxx」「先读 references/yyy」时用它读。" +
          "path 可以是绝对路径，也可以是相对于最近一次 use_skill 加载的技能目录的相对路径。只能读技能 / Power 目录，读不到用户的项目文件。",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "文件或目录路径（绝对路径，或相对于最近加载的技能目录）" },
          },
          required: ["path"],
        },
      },
    };
  }

  /**
   * generate_image 工具定义（文生图）。
   *
   * 与 render_media 的分工必须在描述里说死，否则模型会用代码去"画"写实画面、
   * 或用生图模型去"画"图表——两种都是它做不到的事，结果必然很糟。
   */
  private getGenerateImageToolDef(): ToolDef {
    return {
      type: "function",
      function: {
        name: "generate_image",
        description:
          "根据一段文字描述生成图片（PNG），界面会显示成可点开预览的卡片。\n\n" +
          "【什么时候用】用户要「一张图」：插画、海报、封面、写实照片感画面、风格化渲染、美术版的示意图。" +
          "判断标准是「需要好看」而不是「需要精确」。\n\n" +
          "【不要用】图表、流程图、架构图、数据可视化（这些要精确，用 svg 产物或 render_media）；" +
          "可运行 / 可交互的页面（用 html 产物）；动画或视频（用 render_media）。" +
          "**不要指望图上出现准确文字**——生图模型写字经常是错的、糊的。标题与文字请用 html / svg 排版后叠加，" +
          "或在回复里说明文字无法可靠生成。\n\n" +
          "【怎么写 prompt】按「主体 + 风格 + 构图 + 光线 + 色调」组织，具体名词远比形容词有用：" +
          "「一只橘猫坐在窗台，柔和侧逆光，浅景深，胶片颗粒，暖色调，中景特写」远好于「一只好看的猫」。\n\n" +
          "【negativePrompt】写不想出现的东西（水印、文字、多余肢体、畸形手指）。部分服务商支持，不支持时会被忽略并提示。\n\n" +
          "【参数】width / height 单边 256~2048，默认 1024x1024；count 是**同一提示词出几张**供挑选，" +
          "不是分别画不同内容——要不同画面请分别调用。\n\n" +
          "【产出】每张图都是独立产物，已直接落盘到产物目录。回复里不要粘贴图片数据，简短说明画了什么即可。",
        parameters: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "画面描述：主体、风格、构图、光线、色调" },
            negativePrompt: { type: "string", description: "可选：不想出现的内容（水印、文字、多余肢体等）" },
            width: { type: "number", description: "画面宽（像素），默认 1024，范围 256~2048" },
            height: { type: "number", description: "画面高（像素），默认 1024，范围 256~2048" },
            count: { type: "number", description: "同一提示词生成几张，默认 1，最多 4" },
            title: { type: "string", description: "可选：文件标题（简短），不填则取提示词前 20 字" },
          },
          required: ["prompt"],
        },
      },
    };
  }

  /**
   * render_media 工具定义：把 HTML 动画渲染成 GIF / MP4。
   *
   * 描述里把「渲染契约」写死，因为渲染是确定性逐帧截图，不是录屏：
   * 页面里靠真实时间、用户交互、外部网络的写法，到了这里就是一张静止的图或一块空白。
   * 模型不知道这些约束就会反复交出"看起来没动"的片子，白烧几十秒渲染时间。
   */
  private getRenderMediaToolDef(): ToolDef {
    return {
      type: "function",
      function: {
        name: "render_media",
        description:
          "把你写的一段 HTML 动画渲染成 GIF 或 MP4 文件，界面会显示成可播放的卡片。\n\n" +
          "【什么时候用】用户明确要「动画 / 视频 / GIF / 会动的演示」，并且希望拿到文件。" +
          "讲解算法、产品演示、数据可视化动画、带字幕的解说短片都适合。\n" +
          "【不要用】静态图（用 svg 产物）、流程图 / 时序图（用 mermaid）、需要用户交互的页面（用 create_artifact 的 html）。\n" +
          "【做不到的】实拍或写实镜头、人物口型、克隆声音、外部素材（音乐文件 / 录音）——不要承诺这些。声音只有两种来源：本机合成的旁白、以及你用代码合成的音效 / 背景音乐。\n\n" +
          "【声音规则】GIF 没有音轨（要声音必须选 mp4）。两种来源可以同时用：\n" +
          "  a) 旁白 narration 参数：本机语音合成，音色是系统自带的，不要夸大效果。\n" +
          "  b) 音效 / 背景音乐：在 HTML 里定义 `window.renderAudio = async (ctx) => { ... }`，ctx 是已按成片时长、44100Hz、双声道创建好的 OfflineAudioContext。" +
          "在里面用 OscillatorNode / GainNode / BiquadFilter / AudioBufferSource 搭出声音并连到 ctx.destination，**不要自己调用 startRendering**，渲染器会接管并把它与旁白混流。" +
          "要循环背景乐就按成片时长铺满，要提示音就在指定时刻用 gain 包络断点插入。\n\n" +
          "【画面品质（目标：影视级动效，不是 SVG 色块堆叠）】\n" +
          "先定设计系统再写页面，不要边写边加样式：\n" +
          "1. 配色：主色 + 强调色 + 中性灰阶，总共不超过 5 色。深底用 #0b0b0f~#14141a 的近黑，不要纯黑；正文不要纯白，用 #e6e6ea 这类微暖白；强调色只落在关键的一两个元素上。\n" +
          "2. 字体：标题 / 副标题 / 正文 / 数字各定一档字号字重，全程只用这 4 档。数字与英文用 ui-monospace 做对比。\n" +
          "3. 间距：一律用 8 的倍数，画面四周至少留 64px；宁可大留白，不要把画面塞满。\n" +
          "4. 景深与空间：容器加 perspective，内容用 translateZ 分出 3~4 层；背景层加 filter: blur(6px) 虚化、前景保持清晰，画面立刻有纵深。禁止所有元素挤在同一平面。\n" +
          "5. 光影：用 radial-gradient 在画面角落铺光源；关键元素用 box-shadow 做柔和辉光；光效层用 mix-blend-mode: screen 叠加。不要纯色平涂。\n" +
          "6. 镜头：整个场景容器做缓慢推拉（transform: scale(1→1.06) 或轻微 translate），时长覆盖全片，模拟 dolly 运动；同一时刻只让一个主要元素在动。\n" +
          "7. 材质：叠一层极淡的噪点或网格纹理（opacity ≤ 0.06）；要玻璃感用 backdrop-filter: blur()。\n" +
          "8. 禁止：所有元素同一平面、纯色大色块、无光影的扁平排布、emoji 当图标、文字贴边、生硬 translate 位移、PPT 式排版。\n\n" +
          "【运镜与 3D（让画面像镜头拍的，不是平面排版）】\n" +
          "9. 运镜：不要只让元素动，要让镜头动。把整个场景包进一个容器（父层 perspective: 1200px、transform-style: preserve-3d），" +
          "对容器做 transform 动画：推镜 translateZ(-200px → 80px)、摇镜 rotateY(±8deg)、横移 translateX、升降 translateY。" +
          "一条片子用 1~2 个运镜就够，起幅和落幅要稳，不要全程晃。\n" +
          "10. 3D 空间：优先用 CSS 3D——子元素用 translateZ 分层（背景 -120px、主体 0、前景 60px），转动容器就有真实视差。" +
          "需要真三维（光照、材质、自由相机）时用内置的 Three.js：<script src=\"/vendor/three.min.js\"></script>（这是本地内置库，**不要换成 CDN**），" +
          "用 PerspectiveCamera + MeshStandardMaterial + 环境光 / 方向光，让相机绕物体做轨道运动。\n" +
          "11. Three.js 必须确定性：不要用 requestAnimationFrame 的真实时间驱动，" +
          "改为定义 window.renderFrame = (t) => { 按 t 设置相机位置和物体姿态; renderer.render(scene, camera); }。\n\n" +
          "【HTML 渲染契约（必须遵守，否则成片是静止的或空白的）】\n" +
          "1. 完整的单文件 HTML，样式和脚本全部内联。**所有网络请求会被拦截**：不能用 CDN、外链字体、外链图片，需要的东西自己内联（SVG / CSS / data URI）。\n" +
          "2. 页面按 width x height 的固定画布设计：body 设 margin:0、overflow:hidden，主体撑满画布；不要依赖滚动或响应式断点。\n" +
          "3. 动画从 t=0 开始、到 durationSec 结束，不依赖点击 / 悬停 / 键盘等交互，也不要等用户操作后才开始。\n" +
          "4. 时间是**确定性逐帧推进**的，不是录屏。可靠的写法有两种：\n" +
          "   a) CSS animation / transition / Web Animations API：渲染器会逐帧定位到对应时刻，推荐优先用，设 animation-fill-mode: both。\n" +
          "   b) Canvas / JS 驱动：定义 window.renderFrame = function(t){ ... }，t 为当前秒数（浮点），在里面按 t 绘制整个画面。" +
          "     不要在 renderFrame 里累加状态，要做成 t 的纯函数，这样每帧结果才稳定。\n" +
          "   requestAnimationFrame / setTimeout / Date.now() 也会被接管成同一条时间线，但优先用 a) 或 b)。\n" +
          "5. 不要用 <video> / <audio> 标签，也不要依赖随机数（Math.random 会让每帧不一致，需要随机就用固定种子）。\n" +
          "6. GIF 想循环自然，让最后一帧接近第一帧。\n\n" +
          "【旁白】narration 写成口语化的完整句子，系统语音偏慢，按每秒约 3 个汉字估算（实测 14 字约 4 秒、46 字约 13 秒）；时长以旁白为准会自动延长，" +
          "所以让画面节奏和旁白长度大致对得上，别写 200 字旁白配 3 秒动画。\n\n" +
          "【渲染很慢】每秒约几十帧要逐帧截图：30 秒的 MP4 要等一两分钟，60fps × 60 秒（3600 帧）需要 6~9 分钟。" +
          "先做短版本让用户确认，再按需加长；超长片建议拆成几段分别渲染。" +
          "一次调用只出一个文件，需要 GIF 和 MP4 两份就分别调用。\n\n" +
          "【修改已有成片】重新调用本工具、传入修改后的完整 HTML；同名标题会自动保存为新版本。" +
          "调用成功后不必再贴 HTML，简短说明成片内容即可；渲染结果里若有「注意」，如实转告用户，不要假装成片是完整的。\n\n" +
          "【对外表述】上面这些实现方式（renderAudio、Web Audio、OfflineAudioContext、采样率、混流等）是内部约定，" +
          "只用于你写内容。回复用户时只说结果和能力边界（能出什么、做不到什么），**不要复述这些技术名词，也不要说\"我通过 xxx 合成\"**。",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string", description: "成片标题，简短（如“冒泡排序演示”）。会用作文件名，不要带路径或扩展名。" },
            html: { type: "string", description: "完整的单文件 HTML 动画，遵守上面的渲染契约" },
            format: { type: "string", enum: ["gif", "mp4"], description: "gif=无声循环动画；mp4=可带旁白。要声音必须选 mp4" },
            durationSec: { type: "number", description: "成片时长（秒）。mp4 默认 5、最长 60；gif 默认 3、最长 15。有旁白且旁白更长时会自动延长" },
            width: { type: "number", description: "画面宽（像素）。mp4 默认 1280，gif 默认 640；单边最高 1920（gif 960）" },
            height: { type: "number", description: "画面高（像素）。mp4 默认 720，gif 默认 360；单边最高 1920（gif 960），且总像素不超过 1920x1080（gif 960x540）。横屏 1920x1080、竖屏 1080x1920 都支持" },
            fps: { type: "number", description: "帧率。mp4 默认 24（最高 60），gif 默认 12（最高 15）。越高渲染越慢，60fps 只建议用于短视频和高速运动画面" },
            narration: { type: "string", description: "旁白文本（本机语音合成）。仅 mp4 有效；不填则成片无声" },
          },
          required: ["title", "html", "format"],
        },
      },
    };
  }

  /**
   * report_outputs 工具定义（Cowork 专用）。
   *
   * ── 为什么要让 Agent 主动报，而不是我们去扫目录 ──
   * 扫目录是在猜：要猜扫哪几个根（用户可能没设产出目录）、猜哪些文件算"产出"
   * （Agent 为处理 Excel 写的临时 .py 不算）、还要靠 mtime diff 区分新旧。
   * 每一层猜测都有失准的可能，实际也确实踩了 —— 产出卡片空着、或把临时脚本当成果。
   *
   * 而 Agent 自己最清楚它刚做出了什么：哪个是最终交付物、哪个只是中间脚本。
   * 直接问它要，一次调用就拿到准确清单，还能附一句说明。
   */
  private getDeliverToolDef(): ToolDef {
    return {
      type: "function",
      function: {
        name: "report_outputs",
        description:
          "把你为用户做出来的【最终产出文件】登记一下，界面会把它们显示成可以直接点开预览的卡片。\n\n" +
          "【什么时候调用】完成用户交给你的文档/表格任务、确实生成或改写了文件之后，" +
          "在你给出最终回复【之前】调用一次。一轮只调用一次，把本轮所有产出一起传进来。\n\n" +
          "【哪些算产出】用户真正要的东西：生成的 Excel/Word/PDF/CSV、改写过的原文件、导出的图片。\n" +
          "【哪些不算】你为了干活写的临时脚本（.py/.js 等）、中间缓存、备份副本、日志。" +
          "这些对用户没有意义，登记进去反而会让他以为那就是成果。\n\n" +
          "【路径要求】必须是绝对路径，且文件确实已经写到磁盘上了。" +
          "拿不准完整路径时先用 list_dir 确认，不要凭记忆拼一个。\n\n" +
          "【产出类型】为每个文件自行判断并填写 kind：created 表示本轮新创建的文件，edited 表示本轮修改了已有文件。" +
          "另存为新文件属于 created；原文件原地修改属于 edited。不要根据文件扩展名判断。\n\n" +
          "【没有产出就不要调用】纯问答、只是读文件分析、或任务失败没产出任何文件时，跳过这个工具。",
        parameters: {
          type: "object",
          properties: {
            files: {
              type: "array",
              description: "本轮产出的文件清单（绝对路径）。按对用户的重要程度排序，最重要的放第一个。",
              items: {
                type: "object",
                properties: {
                  path: { type: "string", description: "文件的绝对路径" },
                  kind: { type: "string", enum: ["created", "edited"], description: "本轮对该文件的操作：created=新建，edited=修改已有文件" },
                  note: { type: "string", description: "可选：一句话说明这个文件是什么（如\"按部门汇总的总表\"）" },
                },
                required: ["path", "kind"],
              },
            },
          },
          required: ["files"],
        },
      },
    };
  }

  /**
   * report_checks 工具定义（Cowork 专用）：做完后的自查结果。
   *
   * 财务、会计最怕「数字错了还看不出来」。让 Agent 在交付前按核对项逐条验证，
   * 并把结果（通过 / 需留意 / 不通过 + 具体数字）登记出来，界面渲染成核对清单。
   */
  private getReportChecksToolDef(): ToolDef {
    return {
      type: "function",
      function: {
        name: "report_checks",
        description:
          "登记你对本轮结果做的核对，界面会显示成一张核对清单，让用户一眼看出结果能不能信。\n\n" +
          "【什么时候调用】交付文件之前，真正去验证过之后调用一次（通常紧挨着 report_outputs）。" +
          "用户给了核对项就逐条核对；没给就自己挑最容易出错的地方核对：金额合计、条数、有无遗漏或重复、日期范围。\n\n" +
          "【必须真的验证过】每一条都要基于你实际算出来或读出来的数字，detail 里写清楚数字，" +
          "例如「汇总表合计 128,430.50，三张原表加总 128,430.50，一致」。没验证就不要写 pass。\n\n" +
          "【status】pass=核对一致；warn=能交付但有需要用户留意的地方（如 2 行缺少日期，已标黄）；" +
          "fail=核对不一致且没能解决。有 fail 时要在最终回复里说明原因和建议。\n\n" +
          "【不要调用】纯问答、只是读文件回答问题、没有可核对内容时跳过。",
        parameters: {
          type: "object",
          properties: {
            checks: {
              type: "array",
              description: "核对结果，2 到 8 条",
              items: {
                type: "object",
                properties: {
                  label: { type: "string", description: "核对的是什么，如「合计金额」「记录条数」" },
                  status: { type: "string", enum: ["pass", "warn", "fail"] },
                  detail: { type: "string", description: "具体数字和结论，一句话" },
                },
                required: ["label", "status", "detail"],
              },
            },
          },
          required: ["checks"],
        },
      },
    };
  }

  /**
   * ask_user 工具定义：主 Agent 专用，把"需要用户拍板的选择"变成可点选的问答卡片。
   * 子 Agent 拿不到用户（会死等），故不放通用工具集，只在这里注入。
   */
  private getAskUserToolDef(): ToolDef {
    return {
      type: "function",
      function: {
        name: "ask_user",
        description:
          "当你需要用户在若干方案/选项之间做选择时调用（单选或多选），用户在界面上点选作答，" +
          "结果会作为本工具的返回值给你。\n\n" +
          "【什么时候用】你本来打算写一段「你倾向于 A 还是 B？」然后停下等用户回复——这类场景改用它，" +
          "用户点一下即可，比手打更快也更准确。\n" +
          "- 让用户在几个实现方案里挑一个 → multi=false\n" +
          "- 让用户勾选需要包含的可选步骤/内容 → multi=true\n\n" +
          "【可以一次问多个】questions 是数组，一次可问 1~4 个问题；用户在同一个卡片里用「第 n / N 题」逐题作答，" +
          "比一轮一轮地问更省事。若几个问题彼此独立、都需要用户拍板，就放进同一个 questions 里。\n\n" +
          "【不要用在】需要用户提供自由文本、路径、代码这类没有固定选项的输入——那种情况直接在回复里提问即可。\n\n" +
          "【格式要求】每个问题最多 4 个选项（超出会被截断），每个选项给一个简短 label；" +
          "必要时加一句 description 说明差异或代价。不要自己写「其他/以上都不是」这类选项——" +
          "界面会自动提供「其他（自己输入）」入口（除非你显式把 allowOther 设为 false）。" +
          "用户作答后你会收到「用户的选择：…」（逐题列出），据此继续，不要重复追问。",
        parameters: {
          type: "object",
          properties: {
            questions: {
              type: "array",
              description: "要问用户的问题列表（1~4 个）",
              items: {
                type: "object",
                properties: {
                  question: { type: "string", description: "问题（简短、明确）" },
                  options: {
                    type: "array",
                    description: "选项列表（2~4 个，最多 4 个）。不要自己加「其他」选项，界面会自动提供",
                    items: {
                      type: "object",
                      properties: {
                        label: { type: "string", description: "选项标题（简短，显示在选项行上）" },
                        description: { type: "string", description: "可选：一句话说明该选项的差异/代价/适用场景" },
                      },
                      required: ["label"],
                    },
                  },
                  multi: { type: "boolean", description: "true=多选（checkbox），false=单选（radio）。默认 false" },
                  allowOther: { type: "boolean", description: "是否允许用户自己输入「其他」答案。默认 true" },
                },
                required: ["question", "options"],
              },
            },
          },
          required: ["questions"],
        },
      },
    };
  }

  /**
   * ask_form 工具定义：主 Agent 专用，把「需要用户填一套参数」交付成一张声明式表单。
   *
   * 与 ask_user 的分工：在几个方案里挑一个 → ask_user（更轻，点一下就好）；需要用户给具体值
   * （路径、数量、端口、名称清单）或要一份带多列的清单/表格 → ask_form。
   * 两者都需要用户在场，同样不给子 Agent（会死等）。
   */
  private getAskFormToolDef(): ToolDef {
    return {
      type: "function",
      function: {
        name: "ask_form",
        description:
          "当你需要用户【填一套参数】或【在表格里逐项确认】时调用：把要收集的内容声明成一张表单，" +
          "用户在界面上填写（文本、数字、下拉、单选、多选、开关、滑块、日期，甚至可编辑的表格），" +
          "提交结果会作为本工具的返回值给你。\n\n" +
          "【和 ask_user 怎么选】只在几个方案里挑一个 → ask_user，用户点一下就好；" +
          "需要用户给具体值（路径、数量、端口、名称清单），或要一份带多列的清单/表格 → ask_form。\n\n" +
          "【只描述控件，不要写界面代码】form.fields 是字段数组，每个取值字段给 type + name（+ label）；" +
          "不要在 label / help 里写 HTML 或脚本。支持的 type：text / textarea / number / select / radio / " +
          "checkbox / switch / slider / date / time / tags / table；另有两种排版用的：section（分组标题）、note（说明文字）。\n\n" +
          "【默认值很重要】能从上下文推断的就用 default 预填（例如你刚读到的实际配置值），" +
          "让用户多数情况下只需确认或微调，而不是从零填写。\n\n" +
          "【表格】type=table 必须给 columns（key/label/type）和 data（初始行）；" +
          "selectable=true 允许勾选行、addable=true 允许加行、rowActions 给行内操作按钮（如 删除）。" +
          "用户点行内按钮时，会把「当前全部值 + 该按钮」一起回传给你。\n\n" +
          "【一次只抛一张】拿到提交结果后再决定下一步；不要连续抛多张表单，也不要在同一轮里既抛表单又问选项。",
        parameters: {
          type: "object",
          properties: {
            form: {
              type: "object",
              description: "表单声明",
              properties: {
                title: { type: "string", description: "表单标题（简短，如「配置部署参数」）" },
                description: { type: "string", description: "可选：一句话说明为什么要填这些" },
                submitLabel: { type: "string", description: "提交按钮文案，默认「提交」" },
                buttons: {
                  type: "array",
                  description: "可选：次级动作按钮（如「取消」）。点击同样回传当前值与按钮 id",
                  items: {
                    type: "object",
                    properties: { id: { type: "string" }, label: { type: "string" } },
                    required: ["id", "label"],
                  },
                },
                fields: {
                  type: "array",
                  description: "字段列表（按顺序渲染）。每项必须有 type；取值字段还要有 name。",
                  items: {
                    type: "object",
                    properties: {
                      type: {
                        type: "string",
                        enum: [
                          "text", "textarea", "number", "select", "radio", "checkbox", "switch",
                          "slider", "date", "time", "tags", "table", "section", "note",
                        ],
                        description: "控件类型",
                      },
                      name: { type: "string", description: "提交时的键（英文短标识，如 env、replicas）；section / note 不需要" },
                      label: { type: "string", description: "展示给用户的标签" },
                      help: { type: "string", description: "可选：控件下方的说明文字" },
                      placeholder: { type: "string", description: "输入框占位提示" },
                      required: { type: "boolean", description: "是否必填" },
                      default: { description: "默认值（字符串 / 数字 / 布尔 / 数组）" },
                      options: {
                        type: "array",
                        description: "select / radio / checkbox 的选项",
                        items: {
                          type: "object",
                          properties: {
                            value: { type: "string", description: "回传值；省略时用 label" },
                            label: { type: "string", description: "展示文案" },
                            description: { type: "string", description: "可选：选项补充说明" },
                          },
                          required: ["label"],
                        },
                      },
                      min: { type: "number", description: "number / slider 的最小值" },
                      max: { type: "number", description: "number / slider 的最大值" },
                      step: { type: "number", description: "number / slider 的步长" },
                      rows: { type: "number", description: "textarea 显示的行数" },
                      title: { type: "string", description: "section 的分组标题" },
                      text: { type: "string", description: "note 的说明正文" },
                      columns: {
                        type: "array",
                        description: "table 的列定义",
                        items: {
                          type: "object",
                          properties: {
                            key: { type: "string", description: "对应行对象里的键" },
                            label: { type: "string", description: "列标题" },
                            type: { type: "string", enum: ["text", "number", "select"], description: "单元格类型" },
                            editable: { type: "boolean", description: "默认 true；false = 只读列" },
                            options: {
                              type: "array",
                              description: "type=select 时的选项",
                              items: {
                                type: "object",
                                properties: { value: { type: "string" }, label: { type: "string" } },
                                required: ["label"],
                              },
                            },
                          },
                          required: ["key", "label"],
                        },
                      },
                      data: { type: "array", description: "table 的初始行（对象数组，键对应 columns 的 key）", items: { type: "object" } },
                      selectable: { type: "boolean", description: "table：是否允许勾选行" },
                      addable: { type: "boolean", description: "table：是否允许用户新增行" },
                      removable: { type: "boolean", description: "table：是否允许删除行，默认 true" },
                      rowActions: {
                        type: "array",
                        description: "table：行内操作按钮",
                        items: {
                          type: "object",
                          properties: {
                            id: { type: "string" },
                            label: { type: "string" },
                            danger: { type: "boolean", description: "true = 危险操作（红色）" },
                          },
                          required: ["id", "label"],
                        },
                      },
                    },
                    required: ["type"],
                  },
                },
              },
              required: ["fields"],
            },
          },
          required: ["form"],
        },
      },
    };
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
            "1. brainstorm：澄清目标/范围/验收标准（苏格拉底式追问）→ relay_save_doc(phase=\"brainstorm\") 写 requirements.md，分段呈现确认。\n" +
            "2. design（用户确认后 relay_advance 推进）：架构/模块划分/数据流 → relay_save_doc(phase=\"design\") 写 design.md。\n" +
            "3. plan：拆成小颗粒可独立验证任务清单（2-5min/项），relay_save_doc(phase=\"plan\") 写 plan.md【必须用复选框格式】。\n" +
            "   拆任务铁律：按纵向功能单元拆（导航栏/表单/图表等），严禁按\"HTML一个任务、CSS一个任务\"横切。\n" +
            "4. executing（用户确认后 relay_advance 推进）：逐项 relay_update_task(in_progress) → 实现 → 自测 → relay_review_task 评审 → relay_update_task(completed)，一口气跑完。\n\n" +
            "【执行模式】默认传 strict。创建 Relay 时前端确认条会让用户选择严格模式或全自动模式，并以该选择覆盖 mode 参数；不要在对话里额外询问模式偏好。\n" +
            "- strict：每阶段写完文档后停下等用户确认再推进。\n" +
            "- auto：全自动推进，不等每阶段确认。\n\n" +
            "【评审门】只有 critical 级别问题才阻断任务完成，major/minor 作为建议不阻断。\n" +
            "【连续执行】进入 executing 后连续推进所有任务，仅评审打回/环境阻塞/全部完成时停下。\n" +
            "\n" +
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
    ];
  }
}
