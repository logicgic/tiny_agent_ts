import fs from 'node:fs';
import { OpenAI } from 'openai';
import { AgentLoop } from './loop.js';
import { ContextBuilder } from './context.js';
import { MemoryStore } from './memory.js';
import { SkillsLoader } from './skillsLoader.js';
import { ToolRegistry } from './tools.js';

type AgentConfig = {
  workspace_dir: string;
  openai_api_key?: string;
  base_url?: string;
  model?: string;
};

type AgentEvent = Record<string, unknown>;
/**
 * 高层封装：TinyAgent这是提供给外部调用的主要入口。内部组合了 Memory、Skills、Context 和 Loop 等组件。
 */
export class TinyAgent {
  private workspace_dir: string;
  private openai_api_key: string;
  private base_url: string | undefined;
  private model: string;
  private openai: OpenAI;
  public memory: MemoryStore;
  public skills: SkillsLoader;
  public tools: ToolRegistry;
  public context: ContextBuilder;
  public loop: AgentLoop;

/**
 * 初始化智能体
 * @param config 配置对象
 * @description 初始化智能体，配置OpenAI API客户端
 * - workspace_dir: 工作空间目录，必填
 * - openai_api_key: OpenAI API 密钥，必填
 * - base_url: OpenAI API 基础 URL，用于兼容代理/第三方服务地址
 * - model: 模型名称，可选，默认 "deepseek-v4-flash"
 */
  constructor(config: AgentConfig) {
    if (!config.workspace_dir) {
      throw new Error("workspace_dir 为空");
    }
    this.workspace_dir = config.workspace_dir;

    fs.mkdirSync(this.workspace_dir, { recursive: true });

    const api_key = config.openai_api_key ?? process.env.OPENAI_API_KEY;
    if (!api_key) {
      throw new Error('未提供 openai_api_key，且环境变量 OPENAI_API_KEY 为空');
    }
    this.openai_api_key = api_key;
    this.base_url = config.base_url;
    this.model = config.model ?? 'gpt-4o-mini';

    const api_kwargs: { apiKey: string; baseURL?: string } = {
      apiKey: this.openai_api_key,
    };
    if (this.base_url) {
      api_kwargs.baseURL = this.base_url;
    }

    this.openai = new OpenAI(api_kwargs);
    this.memory = new MemoryStore(this.workspace_dir);
    this.skills = new SkillsLoader(this.workspace_dir);
    this.tools = new ToolRegistry();
    this.context = new ContextBuilder(this.memory, this.skills, this.workspace_dir);
    this.loop = new AgentLoop(this.openai, this.tools, this.model);
  }

    /**核心的对外交互接口。接收字符串，返回事件流（AsyncGenerator）。
        调用流程概览：
        1. 拿到用户的当前问题。
        2. 将问题连同历史记录、系统提示组装成一整条消息 Payload：`messages`。
        3. 用 Generator 的方式透传 `loop` 执行产生的所有状态与文字输出。
        4. 最后完成时，将本次对答新增好的多轮记录（User, Assistant, Tool等）追加进入记忆存储库 `MemoryStore`。
     */
    async *chat_stream(message: string, media?: string[]): AsyncGenerator<AgentEvent, void, unknown> {
        // 1. 组装发往大模型的初始 Payload
        const messages_payload = this.context.build_messages(message, media);

        // 把用户的消息率先单独加入记忆，代表一轮交互正式开始
        this.memory.addMessage({
            role: 'user',
            content: message,
        });

        // 2. 下沉进核心 Loop 返回流
        for await (const event of this.loop.run(messages_payload)) {
            const event_type = event.type;
            if (event_type === 'turn_end') {
                // 解析本轮的所有辅助和回复消息并添加到 Memory 中
                const new_msgs = Array.isArray(event.new_messages) ? event.new_messages : [];
                for (const msg of new_msgs) {
                    if (msg && typeof msg === 'object') {
                        // User 的不重复添加，其余添加进记忆（比如 assistant 和 tool）
                        this.memory.addMessage(msg as Record<string, unknown>);
                    }
                }
            } else if (event_type === 'token_usage') {
                // 保存 token 到持久化记忆
                const p_tokens = typeof event.prompt_tokens === 'number' ? event.prompt_tokens : 0;
                const c_tokens = typeof event.completion_tokens === 'number' ? event.completion_tokens : 0;
                this.memory.add_Tokens(p_tokens, c_tokens);
                yield event;
            } else {
                yield event;
            }
        }
    }
    /**
     * 兼容当前 TS 项目接口：chat 等价于 chat_stream
     */
    async *chat(message: string, media?: string[]): AsyncGenerator<AgentEvent, void, unknown> {
        yield* this.chat_stream(message, media);
    }
    /**
     * 透出所有的技能清单用于前端呈现
     */
    listSkills() {
        return this.skills.get_skills_summary();
    }
    /**
     * 透出当前支持的工具清单用于前端呈现
     */
    listTools() {
        return this.tools.get_tools_summary();
    }
    /**
     * 重置当前会话，清除所有历史记录和状态
     */
    clearMemory() {
        this.memory.clearHistory();
    }

}
