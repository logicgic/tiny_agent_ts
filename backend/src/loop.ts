import type { ToolRegistry } from './tools.js';
import { OpenAI } from 'openai';

type MessageDict = Record<string, any>;
type EventDict = Record<string, any>;

/**
 * 事件循环模块。
 * 核心职责：
 * 1. 调用模型获取流式返回
 * 2. 判断是返回纯文本还是触发 Tool Call
 * 3. 解析 Tool Call 并调度 ToolRegistry 执行
 * 4. 将工具结果回注上下文并继续请求大模型（循环直到结束）
 * 5. 通过 Async Generator 透传全过程状态（用于 SSE 推送和可视化）
 */
export class AgentLoop {
    private client: OpenAI;
    public tool_registry: ToolRegistry;
    public model: string;
    constructor(client: OpenAI, tool_registry: ToolRegistry, model: string){
        this.client = client;
        this.tool_registry = tool_registry;
        this.model = model;
    }
    /**启动与大模型的交互。 
        产生字典形式的事件：
        {
          "type": "text_delta" | "tool_call_start" | "tool_call_end" | "token_usage",
          "content": "", ...
        }
    */
    async *run(messages: MessageDict[]): AsyncGenerator<EventDict, void, unknown> {
        let current_messages = [...messages];
        const max_iterations = 10;  // 防止无限死循环调用工具的防御阈值
        let iteration = 0;
        const tools_def = this.tool_registry.get_definitions();

        while (iteration < max_iterations) {
            iteration += 1;

            // 清理消息历史中的非法字段（如空 tool_calls），兼容各路 API 后端的差异
            const cleaned_messages: MessageDict[] = [];
            for (const m of current_messages) {
                const new_m: MessageDict = { ...m };
                if ('tool_calls' in new_m && !new_m.tool_calls) {
                    delete new_m.tool_calls;
                }
                if ('content' in new_m && new_m.content === '') {
                    new_m.content = null;
                }
                cleaned_messages.push(new_m);
            }

            // 准备 API 请求的配置
            const api_kwargs: MessageDict = {
                model: this.model,
                messages: cleaned_messages,
                stream: true,
                stream_options: { include_usage: true },
            };
            if (tools_def && tools_def.length > 0) {
                api_kwargs.tools = tools_def;
            }

            try {
                const response_stream = await this.client.chat.completions.create(api_kwargs as any) as any;
                const assistant_msg: MessageDict = { role: 'assistant', content: '' };
                const tool_call_buffer: Record<number, MessageDict> = {};
                for await (const chunk of response_stream) {
                    if ('usage' in chunk && chunk.usage) {
                        yield {
                            type: 'token_usage',
                            total_tokens: chunk.usage.total_tokens,
                            prompt_tokens: chunk.usage.prompt_tokens,
                            completion_tokens: chunk.usage.completion_tokens,
                        };
                    }

                    if (!chunk.choices || chunk.choices.length === 0) {
                        continue;
                    }

                    const first_choice = chunk.choices[0];
                    if (!first_choice) {
                        continue;
                    }
                    const delta = first_choice.delta;
                    // 普通文本的 delta 输出
                    if (delta.content) {
                        assistant_msg.content += delta.content;
                        yield { type: 'text_delta', content: delta.content };
                    }

                    //工具调用的 delta 输出
                    if (delta.tool_calls) {
                        for (const tc of delta.tool_calls) {
                            const idx = tc.index;
                            if (!(idx in tool_call_buffer)) {
                                tool_call_buffer[idx] = {
                                    id: tc.id ?? '',
                                    type: 'function',
                                    function: {
                                        name: tc.function?.name ?? '',
                                        arguments: tc.function?.arguments ?? '',
                                    },
                                };
                            } else {
                                if (tc.id && tool_call_buffer[idx]) {
                                    tool_call_buffer[idx].id += tc.id;
                                }
                                if (tool_call_buffer[idx] && tc.type === 'function' && tool_call_buffer[idx].type === 'function') {
                                    const fn = tool_call_buffer[idx].function;
                                    if (tc.function?.name) fn.name += tc.function.name;
                                    if (tc.function?.arguments) fn.arguments += tc.function.arguments;
                                }
                            }
                        }
                    }
                }
                // 情况 1: 装配好了 tool_calls
                if (Object.keys(tool_call_buffer).length > 0) {
                    assistant_msg.tool_calls = Object.entries(tool_call_buffer)
                    .sort(([aIdx], [bIdx]) => Number(aIdx) - Number(bIdx))   // 按 idx 升序
                    .map(([, call]) => call);                                 // 只要 call的内容
                }
                //处理空内容，防止 OpenAI 报错
                if (!assistant_msg.content) {
                    //如果有工具调用，内容可以为 None；如果没有，某些后端可能要求省略或有内容
                    assistant_msg.content = null;
                }
                current_messages.push(assistant_msg);
                //判断是否有 tool call，没有就可以结束了
                if (!assistant_msg.tool_calls || assistant_msg.tool_calls.length === 0) {
                    break;
                }
                //处理每个工具的调用结果
                for (const tc of assistant_msg.tool_calls as MessageDict[]) {
                    if (tc.type === 'function') {
                        const tool_name = tc.function.name;
                        const tool_args_str = tc.function.arguments;

                        yield { type: 'tool_call_start',
                            id: tc.id,
                            name: tool_name,
                            arguments: tool_args_str,
                        };
                        console.log(`执行工具 '${tool_name}' 参数: ${tool_args_str}`);
                        const result = await this.tool_registry.execute(tool_name, tool_args_str);
                        console.log(`执行结果: ${result}`);
                        yield { type: 'tool_call_end',
                            id: tc.id,
                            name: tool_name,
                            result_summary: result.slice(0, 100) + (result.length > 100 ? '...' : ''),
                        };
                        current_messages.push({
                            role: 'tool',
                            tool_call_id: tc.id,
                            name: tool_name,
                            content: result,
                        });
                    }
                }
            }
            catch (error: any) {
                yield { type: 'error', content: `调用模型API出错: ${String(error?.message ?? error)}` };
                break;
            }
        }
        yield {
            type: 'turn_end',
            new_messages: current_messages.slice(messages.length),
        };
    }
}
