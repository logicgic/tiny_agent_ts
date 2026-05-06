import path from 'node:path';
import express from 'express';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import multer from 'multer';
import yaml from 'yaml';
import { TinyAgent } from './agent.js';

const app = express();
app.use(express.json({ limit: '2mb' }));
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 50 * 1024 * 1024 },
});

type AppConfig = {
  llm?: {
    api_key?: string;
    base_url?: string;
    model?: string;
  };
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const project_root = path.resolve(__dirname, '..');

// 加载配置文件（兼容 src 与 dist 两种启动路径）
const config_path = path.join(project_root, 'config', 'config.yaml');
let config: AppConfig = {};
if (fs.existsSync(config_path)) {
    try {
        const raw = fs.readFileSync(config_path, 'utf-8');
        config = (yaml.parse(raw) ?? {}) as AppConfig;
    } catch {
        config = {};
    }
}
// 设置大模型
const llm_config = config.llm ?? {};
const workspace_path = path.join(project_root, 'workspace');
const outputs_path = path.join(workspace_path, 'outputs');
fs.mkdirSync(outputs_path, { recursive: true });
const static_path = path.join(project_root, 'frontend', 'static');

if (fs.existsSync(static_path) && fs.statSync(static_path).isDirectory()) {
    app.use('/static', express.static(static_path));
}

app.use('/outputs', express.static(outputs_path));
// 初始化智能体
const agent_config: {
    workspace_dir: string;
    openai_api_key?: string;
    base_url?: string;
    model?: string;
} = {
    workspace_dir: workspace_path,
};
if (llm_config.api_key) {
    agent_config.openai_api_key = llm_config.api_key;
}
if (llm_config.base_url) {
    agent_config.base_url = llm_config.base_url;
}
agent_config.model = llm_config.model ?? "deepseek-v4-flash";

let agent = new TinyAgent(agent_config)

/**
 * @route GET /
 * @desc 返回前端主页
 * @returns HTML
 */
app.get('/',(req:any,res:any)=>{
    const static_index = path.join(static_path, 'index.html');
    if (fs.existsSync(static_index)) {
        res.sendFile(static_index);
        return;
    }
    res.status(404).send('frontend/static/index.html not found');
})
/**
 * @route GET /api/status
 * @desc 获取侧边栏状态（技能与工具）
 * @returns JSON
 */
app.get('/api/status',(req:any,res:any)=>{
    agent.skills.load_all_skills();
    res.json({
        skills: agent.listSkills(),
        tools: agent.listTools(),
    });
})
/**
 * @route POST /api/chat
 * @desc 流式对话（SSE）
 * @body { message: string }
 * @returns text/event-stream (data: <json>\n\n)
 */
app.post('/api/chat',async (req:any,res:any)=>{  
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!message) {
        res.status(400).json({ status: 'error', message: 'message 不能为空' });
        return;
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    try {
        for await (const event of agent.chat_stream(message)) {
            if (req.aborted || res.writableEnded) {
                break;
            }
            const data_str = JSON.stringify(event);
            res.write(`data: ${data_str}\n\n`);
        }
    } catch (error: unknown) {
        const err_msg = error instanceof Error ? error.message : String(error);
        res.write(`data: ${JSON.stringify({ type: 'error', content: err_msg })}\n\n`);
    } finally {
        res.end();
    }
})
/**
 * @route GET /api/memory
 * @desc 获取当前上下文与长期记忆
 * @returns JSON
 */
app.get('/api/memory',(req:any,res:any)=>{
    const messages = agent.memory.getMessages(20);
    const long_term_memory = agent.memory.getLongTermMemory();
    res.json({
        stats: {
            total_messages_in_window: messages.length,
            has_long_term_memory: Boolean(long_term_memory),
        },
        long_term_memory,
    });
})
/**
 * @route GET /api/history
 * @desc 获取历史会话与 token 统计
 * @returns JSON
 */
app.get('/api/history',(req:any,res:any)=>{
    res.json({
        messages: agent.memory.messages,
        tokens: agent.memory.getTokens(),
    });
})
/**
 * @route GET /api/outputs
 * @desc 获取输出文件列表
 * @returns JSON
 */
app.get('/api/outputs',(req:any,res:any)=>{
    const files: Array<{
        name: string;
        size: number;
        mtime: number;
    }> = [];

    if (fs.existsSync(outputs_path)) {
        for (const filename of fs.readdirSync(outputs_path)) {
            const file_path = path.join(outputs_path, filename);
            if (!fs.statSync(file_path).isFile()) {
                continue;
            }
            const stat = fs.statSync(file_path);
            files.push({
                name: filename,
                size: stat.size,
                mtime: stat.mtimeMs / 1000,
            });
        }
        files.sort((a, b) => b.mtime - a.mtime);
    }

    res.json({ files });
})
/**
 * @route DELETE /api/outputs/:filename
 * @desc 删除输出文件
 * @param filename - 输出文件名
 * @returns JSON
 */
app.delete('/api/outputs/:filename',(req:any,res:any)=>{
    const filename = String(req.params?.filename ?? '');
    if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
        res.json({ status: 'error', message: 'Invalid filename' });
        return;
    }

    const file_path = path.join(outputs_path, filename);
    if (!fs.existsSync(file_path) || !fs.statSync(file_path).isFile()) {
        res.json({ status: 'error', message: 'File not found' });
        return;
    }

    try {
        fs.unlinkSync(file_path);
        res.json({ status: 'success', message: `Deleted ${filename}` });
    } catch (error: unknown) {
        const err_msg = error instanceof Error ? error.message : String(error);
        res.json({ status: 'error', message: err_msg });
    }
})
/**
 * @route POST /api/upload
 * @desc 上传文件到 outputs
 * @returns JSON
 */
app.post('/api/upload', upload.single('file'), (req:any,res:any)=>{
    if (!fs.existsSync(outputs_path)) {
        fs.mkdirSync(outputs_path, { recursive: true });
    }

    const file = req.file as Express.Multer.File | undefined;
    if (!file) {
        res.status(400).json({ status: 'error', message: 'Invalid upload payload' });
        return;
    }

    const safe_name = path.basename(file.originalname).trim();
    if (!safe_name) {
        res.status(400).json({ status: 'error', message: 'Invalid filename' });
        return;
    }

    const file_path = path.join(outputs_path, safe_name);
    try {
        fs.writeFileSync(file_path, file.buffer);
        res.json({ status: 'success', filename: safe_name });
    } catch (error: unknown) {
        const err_msg = error instanceof Error ? error.message : String(error);
        res.json({ status: 'error', message: err_msg });
    }
})
/**
 * @route POST /api/clear
 * @desc 清理会话记忆
 * @returns JSON
 */
app.post('/api/clear',(req:any,res:any)=>{
    agent.clearMemory();
    res.json({ status: 'ok' });
})

app.listen(3001, () => {
  console.log('服务已经启动, 端口监听为 3001');
});
