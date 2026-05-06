import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ChatMessage } from "./memory.js";
import { MemoryStore } from "./memory.js";
import { SkillsLoader } from "./skillsLoader.js";

type UserImagePart = {
  type: "image_url";
  image_url: {
    url: string;
  };
};

type UserTextPart = {
  type: "text";
  text: string;
};

type UserContent = string | Array<UserImagePart | UserTextPart>;

/**
 * 上下文构建器模块。
 * 按顺序组装并构建完整的发送给大模型的 Message Payload:
 * 1. System Prompt (包含核心设定，时间，可用技能，长记忆等)
 * 2. 历史对话 (Short-Term Memory)
 * 3. User 的新一条输入
 */
export class ContextBuilder {
  private memory: MemoryStore;
  private skills: SkillsLoader;
  private workspace_dir: string;

  constructor(
    memory_store: MemoryStore,
    skills_loader: SkillsLoader,
    workspace_dir: string,
  ) {
    this.memory = memory_store;
    this.skills = skills_loader;
    this.workspace_dir = workspace_dir;
  }

  /**构建系统提示词 */
  build_system_prompt(): string {
    const parts: string[] = [];

    // 1. 基础人格与时间设定
    parts.push(this._get_identity());

    // 2. 挂载常驻核心技能 (always-loaded skills)
    const always_skills_prompt = this.skills.get_always_skills_prompt();
    if (always_skills_prompt) {
      parts.push(always_skills_prompt);
    }

    // 3. 挂载长期记忆 (如果非空)
    const long_term_fact = this.memory.getLongTermMemory();
    if (long_term_fact) {
      parts.push(`# 工作记忆和参考事实\n\n${long_term_fact}`);
    }

    // 4. 附加可选技能列表清单
    const skills_summary = this.skills.build_skills_summary_prompt();
    if (skills_summary) {
      parts.push(skills_summary);
    }

    return parts.join("\n\n---\n\n");
  }

  /**获取核心人格设定和运行环境信息 */
  private _get_identity(): string {
    const now = new Date();
    const time_str = now.toLocaleString("sv-SE").replace("T", " ");
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const platform_name = process.platform === "darwin" ? "macOS" : process.platform;
    const runtime = `${platform_name} ${os.arch()}, Node ${process.version}`;
    const workspace_path = path.resolve(this.workspace_dir).replaceAll("\\", "/");

    return `你名叫 tinybot，是一个有用的 AI 助手。

## 当前时间
${time_str} (${tz})

## 运行环境
${runtime}

## 工作区
你的工作区位于: ${workspace_path}
- 长期记忆: ${workspace_path}/memory/MEMORY.md
- 历史日志: ${workspace_path}/memory/HISTORY.md (支持 grep 搜索)
- 输出目录: ${workspace_path}/outputs/
- 自定义技能: ${workspace_path}/skills/{skill-name}/SKILL.md

> [!IMPORTANT]
> **绝对强制要求：** 除了读取记忆（\`memory/\`）和读取技能配置（\`skills/\`）外，无论是文档、代码、图片、音频、测试文件还是任何工具的执行生成产物，**只要你需要新建或修改目标文件存放结果，你《必须》将它们统统存放在 \`${workspace_path}/outputs/\` 目录内**。
> **绝不允许**在使用文件操作工具时将其直接放在 \`${workspace_path}\` 根目录或其他未授权位置！如果不指定具体完整路径，请自行在文件名前加上 \`${workspace_path}/outputs/\`。

直接使用文本回复对话。仅在需要发送到特定聊天频道时使用 'message' 工具。

## 工具调用指南
- 在调用工具之前，你可以简要说明你的意图（例如“让我检查一下”），但绝不要在收到结果之前预测或描述预期的结果。
- 不要假设文件或目录存在 — 使用 read_file 或 exec (ls) 来验证。
- 在使用 edit_file 或 write_file 修改文件之前，请先阅读以确认其当前内容。
- 在写入或编辑文件后，如果准确性很重要，请重新阅读它。
- 如果工具调用失败，请在尝试不同方法之前分析错误。

## 记忆
- 记住重要的事实：写入 ${workspace_path}/memory/MEMORY.md
- 回忆过去的事件：使用 grep 搜索 ${workspace_path}/memory/HISTORY.md`;
  }

  /**
   * 组装全部消息用于大模型 API 调用
   */
  build_messages(current_user_message: string, media?: string[]): ChatMessage[] {
    const messages: ChatMessage[] = [];

    // 第一条永远是 System Message
    const system_prompt = this.build_system_prompt();
    messages.push({ role: "system", content: system_prompt });

    // 过去的所有历史 (如果有，且在限制窗口内)
    // 注意: tools 和 tool result 也会保存在 history 里，用于大模型判断前置状态
    const history_msgs = this.memory.getMessages(20);
    messages.push(...history_msgs);

    // 当前轮次用户的输入，追加到 Payload 末尾
    const user_content = this._build_user_content(current_user_message, media);
    messages.push({
      "role": "user",
      "content": user_content,
    });

    return messages;
  }

  /**构建包含可选图片的 User Message Content */
  private _build_user_content(text: string, media?: string[]): UserContent {
    if (!media || media.length === 0) {
      return text;
    }

    const images: UserImagePart[] = [];
    for (const file_path of media) {
      if (!fs.existsSync(file_path) || !fs.statSync(file_path).isFile()) {
        continue;
      }

      const mime = this.guess_image_mime(file_path);
      if (!mime) {
        continue;
      }

      try {
        // 读取图片并编码为 base64 data URL，和 Python 版行为保持一致
        const b64 = fs.readFileSync(file_path).toString("base64");
        images.push({
          "type": "image_url",
          "image_url": { url: `data:${mime};base64,${b64}` },
        });
      } catch {
        // 读取失败时跳过该文件
        continue;
      }
    }

    if (images.length === 0) {
      return text;
    }

    return [...images, { "type": "text", "text": text }];
  }

  private guess_image_mime(file_path: string): string | null {
    // Python 版本是通过 mimetypes.guess_type，这里用扩展名映射实现等价能力
    const ext = path.extname(file_path).toLowerCase();
    const map: Record<string, string> = {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".bmp": "image/bmp",
      ".svg": "image/svg+xml",
    };
    return map[ext] ?? null;
  }

  /**
   * 辅助方法：向消息列表中添加工具执行结果
   */
  add_tool_result(
    messages: ChatMessage[],
    tool_call_id: string,
    tool_name: string,
    result: string,
  ): ChatMessage[] {
    messages.push({
      role: "tool",
      tool_call_id: tool_call_id,
      name: tool_name,
      content: result,
    });
    return messages;
  }

  /**
   * 辅助方法：向消息列表中添加助手的回复
   */
  add_assistant_message(
    messages: ChatMessage[],
    content: string | null,
    tool_calls?: Array<Record<string, unknown>>,
  ): ChatMessage[] {
    const msg: ChatMessage = { role: "assistant", content: content };

    if (tool_calls && tool_calls.length > 0) {
      msg.tool_calls = tool_calls;
    }

    messages.push(msg);
    return messages;
  }
}
