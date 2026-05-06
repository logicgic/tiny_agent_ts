// core/memory.ts
import * as fs from "node:fs";
import * as path from "node:path";
/**轻量级的记忆存储模块，支持对话历史的持久化。
    包含：
      1. message history: 轮次的对话（系统、用户、助手消息）。
      2. long term memory: 一些持久存在的事实（可选的高级功能）。
 */
export type ChatMessage = {
  role?: "system" | "user" | "assistant" | "tool" | string;
  [key: string]: unknown;
};

type TokenStats = {
  "prompt": number;
  "completion": number;
};

export class MemoryStore {
  private memory_Dir: string;
  private history_file: string;
  private tokens_file: string;
  private long_term_file: string;    

  public messages: ChatMessage[];
  private tokens: TokenStats;

  constructor(workspaceDir: string, sessionId = "default") {
    this.memory_Dir = path.join(workspaceDir, "memory");
    fs.mkdirSync(this.memory_Dir, { recursive: true });

    this.history_file = path.join(this.memory_Dir, `${sessionId}_history.json`);
    this.tokens_file = path.join(this.memory_Dir, `${sessionId}_tokens.json`);
    this.long_term_file = path.join(this.memory_Dir, "MEMORY.md");

    // 恢复状态
    this.messages = this.loadHistory();
    this.tokens = this.loadTokens();
  }
/**从文件中加载已消耗的 token 统计 */
  private loadTokens(): TokenStats {
    const defaultTokens: TokenStats = { "prompt": 0, "completion": 0 };

    if (fs.existsSync(this.tokens_file)) {
      try {
        const raw = fs.readFileSync(this.tokens_file, "utf-8");
        const data = JSON.parse(raw) as Partial<TokenStats>;
        return {
          prompt: data.prompt ?? 0,
          completion: data.completion ?? 0,
        };
      } catch {
        return defaultTokens;
      }
    }

    return defaultTokens;
  }
/**保存 token 消耗记录 */
  private saveTokens(){
    fs.writeFileSync(
      this.tokens_file,
      JSON.stringify(this.tokens, null, 2),
      "utf-8"
    );
  }
/**累加 token 消耗*/
  add_Tokens(promptTokens: number, completionTokens: number) {
    this.tokens.prompt += promptTokens;
    this.tokens.completion += completionTokens;
    this.saveTokens();
  }
/**获取当前累加的 token 消耗 */
  getTokens(): TokenStats {
    return this.tokens;
  }
/**从文件中加载对话记录 */
  private loadHistory(): ChatMessage[] {
    if (fs.existsSync(this.history_file)) {
      try {
        const raw = fs.readFileSync(this.history_file, "utf-8");
        return JSON.parse(raw) as ChatMessage[];
      } catch {
        return [];
      }
    }
    return [];
  }
/**保存对话记录到 JSON 文件 */
  private saveHistory() {
    fs.writeFileSync(
      this.history_file,
      JSON.stringify(this.messages, null, 2),
      "utf-8"
    );
  }
/**
 * 新增一条消息到短期历史中并持久化。消息角色通常是 "system", "user", "assistant" 或者是 "tool"。
 */
  addMessage(message: ChatMessage): void {
    this.messages.push(message);
    this.saveHistory();
  }
/** 获取对话历史。为了避免超出 token 限制，可以通过 window_size 截断早期的部分。
        注意：截断不能破坏大模型的连续性要求。例如，如果包含 tool_calls，则必须包含对应的 tool response 消息。
        如果简单按数量截取会导致 orphaned tool_calls，这会引发 API 错误。
        这里我们从后向前遍历找到一个安全的切片点（比如用户最新一轮发起对话的地方，或者确保工具链完整的起始点）。
 */
  getMessages(windowSize = 20): ChatMessage[] {
    if (this.messages.length <= windowSize) {
      return this.messages;
    }

    let startIdx = Math.max(0, this.messages.length - windowSize);

    // 向前找到最近 user 作为安全起点，避免截断 tool 调用链
    while (
      startIdx > 0 &&
      (this.messages[startIdx]?.role ?? "") !== "user"
    ) {
      startIdx -= 1;
    }

    return this.messages.slice(startIdx);
  }
/**读取持久状态的长记忆（如果存在的话） */
  getLongTermMemory(): string {
    if (fs.existsSync(this.long_term_file)) {
      try {
        return fs.readFileSync(this.long_term_file, "utf-8");
      } catch {
        return "";
      }
    }
    return "";
  }
/**保存归纳后的长记忆（供其它 Agent 或任务调用） */
  saveLongTermMemory(memoryText: string): void {
    fs.writeFileSync(this.long_term_file, memoryText, "utf-8");
  }
/**清空当前会话的对话记录及 token 记录 */
  clearHistory(): void {
    this.messages = [];
    this.saveHistory();

    this.tokens = { prompt: 0, completion: 0 };
    this.saveTokens();
  }
}
