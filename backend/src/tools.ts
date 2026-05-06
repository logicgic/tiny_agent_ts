import fs from 'fs';
import path from 'path';
import { promisify } from 'node:util';
import {exec} from 'node:child_process';
const execAsync = promisify(exec);
type parameterDict = Record<string, any>;
type kwargsDict = Record<string, any>;
/**
 *  基础工具类，所有自定义工具都需要继承此类。提供了工具的名称、描述、参数结构等大模型需要的元数据。
 */
/**
 *  基础工具类，所有自定义工具都需要继承此类。提供了工具的名称、描述、参数结构等大模型需要的元数据。
 */
abstract class BaseTool{
    public name: string;
    public description: string;
    public parameters: parameterDict;
    constructor(name: string, description: string, parameters: parameterDict) {
        this.name = name;
        this.description = description;
        this.parameters = parameters;
    } 
    /**将工具转换为 OpenAI API 兼容的 function 格式 */  
    public to_openai_function(){
        return {
            "type": "function",
            "function": {
                "name": this.name,
                "description": this.description,
                "parameters": this.parameters
            }
        }
    }
    /**执行工具的具体逻辑，子类必须实现 */
    abstract execute(kwargs: kwargsDict) : Promise<string>;
}
/**读取文件工具 */
export class ReadFileTool extends BaseTool {
    constructor() {
        super("read_file", "读取指定文件的内容。注意，如果文件太大可能会截断报错。", {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: '要读取的文件的绝对或相对路径',
                    },
                },
                required: ['path'],
        })
    }
    async execute(kwargs:kwargsDict):Promise<string>{
        const filePath = String(kwargs.path ?? '');
        try {
        const content = await fs.promises.readFile(filePath, 'utf-8');
        if (content.length > 10000) {
            return content.slice(0, 10000) + '\n...[文件内容过长被截断]';
        }
        return content;
        } catch (e: any) {
            return `读取文件失败: ${String(e?.message ?? e)}`;
        }
    }    
}
/**写入文件工具 */
export class WriteFileTool extends BaseTool {
  constructor() {
    super(
      'write_file',
      '将内容写入到指定文件中。如果文件不存在则会创建，如果存在则会覆盖。',
      {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '要写入的文件的绝对或相对路径',
          },
          content: {
            type: 'string',
            description: '要写入的内容文本',
          },
        },
        required: ['path', 'content'],
      },
    );
  }

  async execute(kwargs: kwargsDict): Promise<string> {
    const filePath = String(kwargs.path ?? '');
    const content = String(kwargs.content ?? '');
    try {
      const dir = path.dirname(filePath) || '.';
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(filePath, content, 'utf-8');
      return `成功写入文件: ${filePath}`;
    } catch (e: any) {
      return `写入文件失败: ${String(e?.message ?? e)}`;
    }
  }
}
/**编辑文件工具 (简单查找替换) */
class EditFileTool extends BaseTool {
  constructor() {
    super(
      'edit_file',
      '编辑指定文件的内容。通过查找旧字符串并替换为新字符串。建议先读取文件内容确认。',
      {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '要编辑的文件的绝对或相对路径',
          },
          old_str: {
            type: 'string',
            description: '要被替换的原始文本字符串',
          },
          new_str: {
            type: 'string',
            description: '替换后的新文本字符串',
          },
        },
        required: ['path', 'old_str', 'new_str'],
      },
    );
  }

  async execute(kwargs: kwargsDict): Promise<string> {
    const filePath = String(kwargs.path ?? '');
    const oldStr = String(kwargs.old_str ?? '');
    const newStr = String(kwargs.new_str ?? '');

    try {
      if (!fs.existsSync(filePath)) {
        return `错误：文件 ${filePath} 不存在`;
      }

      const content = await fs.promises.readFile(filePath, 'utf-8');

      if (!content.includes(oldStr)) {
        return '错误：在文件内容中未找到指定的 old_str';
      }

      const newContent = content.split(oldStr).join(newStr);
      await fs.promises.writeFile(filePath, newContent, 'utf-8');

      return `成功编辑文件: ${filePath}`;
    } catch (e: any) {
      return `编辑文件失败: ${String(e?.message ?? e)}`;
    }
  }
}
class ShellTool extends BaseTool {
  timeout: number;
  denyPatterns: RegExp[];

  constructor(timeout = 60) {
    super(
      'exec',
      '执行 Shell 命令并返回输出。谨慎使用。',
      {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: '要执行的 Shell 命令',
          },
          working_dir: {
            type: 'string',
            description: '可选的执行目录',
          },
        },
        required: ['command'],
      },
    );

    this.timeout = timeout;
    this.denyPatterns = [
      /\brm\s+-[rf]{1,2}\b/i,
      /\bdel\s+\/[fq]\b/i,
      /\brmdir\s+\/s\b/i,
      /(?:^|[;&|]\s*)format\b/i,
      /\b(mkfs|diskpart)\b/i,
      /\bdd\s+if=/i,
      />\s*\/dev\/sd/i,
      /\b(shutdown|reboot|poweroff)\b/i,
      /:\(\)\s*\{.*\};\s*:/i,
    ];
  }

  private guardCommand(command: string): string | null {
    const cmd = command.trim().toLowerCase();
    for (const pattern of this.denyPatterns) {
      if (pattern.test(cmd)) {
        return '错误: 命令被安全策略拦截 (检测到危险模式)';
      }
    }
    return null;
  }

  async execute(kwargs: kwargsDict): Promise<string> {
    const command = String(kwargs.command ?? '');
    const workingDir = kwargs.working_dir ? String(kwargs.working_dir) : process.cwd();

    const guardError = this.guardCommand(command);
    if (guardError) return guardError;

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: workingDir,
        timeout: this.timeout * 1000,
        windowsHide: true,
        maxBuffer: 10 * 1024 * 1024,
      });

      const outputParts: string[] = [];

      if (stdout) outputParts.push(stdout);
      if (stderr && stderr.trim()) outputParts.push(`STDERR:\n${stderr}`);

      let result = outputParts.length > 0 ? outputParts.join('\n') : '(无输出)';
      if (result.length > 10000) {
        result = result.slice(0, 10000) + `\n... (截断，剩余 ${result.length - 10000} 个字符)`;
      }

      return result;
    } catch (e: any) {
      const stdout = String(e?.stdout ?? '');
      const stderr = String(e?.stderr ?? '');
      const code = e?.code;

      if (e?.killed || e?.signal === 'SIGTERM') {
        return `错误：命令执行超时（超过 ${this.timeout} 秒）`;
      }

      const outputParts: string[] = [];
      if (stdout) outputParts.push(stdout);
      if (stderr && stderr.trim()) outputParts.push(`STDERR:\n${stderr}`);
      if (code !== undefined) outputParts.push(`\n退出状态码: ${code}`);

      const merged = outputParts.length > 0 ? outputParts.join('\n') : `执行命令时发生异常: ${String(e?.message ?? e)}`;
      if (merged.length > 10000) {
        return merged.slice(0, 10000) + `\n... (截断，剩余 ${merged.length - 10000} 个字符)`;
      }
      return merged;
    }
  }
}
    


export class ToolRegistry {
  tools: Record<string, BaseTool>;

  constructor() {
    this.tools = {};
    this.register(new ReadFileTool());
    this.register(new WriteFileTool());
    this.register(new EditFileTool());
    this.register(new ShellTool());
  }

  register(tool: BaseTool): void {
    this.tools[tool.name] = tool;
  }

  get_definitions(): kwargsDict[] {
    return Object.values(this.tools).map((tool) => tool.to_openai_function());
  }

  get_tools_summary(): kwargsDict[] {
    return Object.values(this.tools).map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
  }

  async execute(name: string, arguments_json: string): Promise<string> {
    if (!(name in this.tools)) {
      return `错误：未找到名为 '${name}' 的工具`;
    }

    const tool = this.tools[name];
    if (!tool) return `错误：未找到名为 '${name}' 的工具`;

    try {
      const kwargs = JSON.parse(arguments_json);
      const result = await tool.execute(kwargs);
      return String(result);
    } catch (e: any) {
      if (e instanceof SyntaxError) {
        return '错误：提供的参数不是有效的 JSON 格式';
      }
      return `执行工具 '${name}' 时发生异常: ${String(e?.message ?? e)}`;
    }
  }
}
