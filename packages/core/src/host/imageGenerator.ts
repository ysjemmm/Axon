/**
 * HostImageGenerator —— 文生图（文本 → PNG）
 *
 * ── 与 HostMediaRenderer 的分工（别把两者混成一件） ──
 * mediaRenderer：模型写 HTML 动画，本地无头浏览器逐帧渲染，再编码成 GIF / MP4。
 *   画面完全由代码决定，确定性、可复现、不依赖外部服务。
 * 这里相反：模型只给提示词，画面由外部生图模型产出，必须配置服务商才能用。
 *
 * 所以两种能力不能互相替代：
 *   · 要可控制、可复现的动效 / 图表 / 数据可视化 → render_media
 *   · 要照片感、插画感、写实画面、复杂材质     → 这里（依赖生图模型）
 *
 * 不支持的形态为 undefined（AgentHost.imageGenerator 可选）。
 */

/**
 * 生图限额。参数校验（core）与实现（host）共用同一份，避免两边口径漂移。
 *
 * 这些值是「主流服务商都认」的交集：尺寸取 256~2048，张数取 1~4。
 * 再大或再多不适合塞进一次工具调用——生成慢、失败贵、用户也挑不过来。
 */
export const IMAGE_LIMITS = {
  /** 单边最小像素 */
  minSize: 256,
  /** 单边最大像素 */
  maxSize: 2048,
  /** 单次最多生成几张 */
  maxCount: 4,
  /** 提示词长度上限 */
  maxPromptChars: 2000,
  /** 负面提示词长度上限 */
  maxNegativeChars: 800,
} as const;

/** 一次生图请求 */
export interface ImageGenRequest {
  /** 画面描述：主体、风格、构图、光线、色调 */
  prompt: string;
  /** 负面描述（部分服务商支持，不支持时实现应降级并写进 warnings） */
  negativePrompt?: string;
  width: number;
  height: number;
  count: number;
  /** 产物目录（实现负责创建） */
  outputDir: string;
  /** 文件名主干（不含扩展名）；多张时实现自行追加序号 */
  stem: string;
  signal?: AbortSignal;
  /** 进度回调：requesting = 等服务商返回，downloading = 逐张落盘 */
  onProgress?: (info: { phase: "requesting" | "downloading"; done: number; total: number }) => void;
}

/** 生成出来的单张图 */
export interface ImageGenFile {
  /** 绝对路径 */
  path: string;
  /** 文件字节数 */
  size: number;
}

/** 一次生图的产出 */
export interface ImageGenResult {
  files: ImageGenFile[];
  /**
   * 不致命但用户该知道的情况（如服务商忽略了 negativePrompt、某张图下载失败）。
   * 给模型看，由模型如实转述，不要假装全部成功。
   */
  warnings: string[];
}

/** 环境自检：没配置服务商时 ok=false，problem 说明缺什么、该去哪配 */
export interface ImageGenEnv {
  ok: boolean;
  problem?: string;
}

export interface HostImageGenerator {
  /**
   * 检查生图服务是否可用（配置是否齐全）。便宜、不发请求。
   */
  checkEnv(): Promise<ImageGenEnv>;

  /**
   * 生成并写出图片文件。失败抛错，错误信息要说清原因（未配置 / 鉴权失败 / 内容被拒），
   * 模型会据此决定是提示用户去配置，还是换个描述重试。
   */
  generate(req: ImageGenRequest): Promise<ImageGenResult>;
}
