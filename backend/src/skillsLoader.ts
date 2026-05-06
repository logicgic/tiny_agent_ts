import * as fs from "node:fs";
import * as path from "node:path";
import yaml from "yaml";

type SkillMeta = {
  description?: string;
  active?: boolean;
  always_load?: boolean;
};

type LoadedSkill = {
  name: string;
  description: string;
  active: boolean;
  always_load: boolean;
  path: string;
  content: string;
};
/**
 * 技能加载器模块。
    用于从指定目录加载 Markdown 格式的技能文件 (通常是 SKILL.md)。
    文件中可以包含 YAML frontmatter (包含技能元数据，如描述和状态) 及正文（给 Agent 参考的提示词）。
*/
export class SkillsLoader {
  private skills_dir: string;
  private skills: LoadedSkill[];

  constructor(workspace_dir: string) {
    this.skills_dir = path.join(workspace_dir, "skills");
    this.skills = [];
    this.load_all_skills();
  }

  /**遍历目录并解析出所有可用的技能 */
  load_all_skills() {
    this.skills = [];
    if (!fs.existsSync(this.skills_dir)) {
      fs.mkdirSync(this.skills_dir, { recursive: true });
    }

    this.walk_dir(this.skills_dir);
  }

  private walk_dir(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full_path = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        this.walk_dir(full_path);
        continue;
      }

      if (entry.isFile() && entry.name === "SKILL.md") {
        const skill_name = path.basename(path.dirname(full_path));
        const { meta, content } = this.parse_markdown_with_frontmatter(full_path);
        this.skills.push({
          name: skill_name,
          description: meta.description ?? "无描述",
          active: meta.active ?? true,
          always_load: meta.always_load ?? false,
          path: full_path.replaceAll("\\", "/"),
          content: content,
        });
      }
    }
  }

  /**解析 Markdown 文件，拆分出 YAML header 和剩余内容 */
  private parse_markdown_with_frontmatter(file_path: string): {
    meta: SkillMeta;
    content: string;
  } {
    const text = fs.readFileSync(file_path, "utf-8");
    const match = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n([\s\S]*)$/);
    if (!match) {
      return { meta: {}, content: text.trim() };
    }

    const yaml_content = match[1] ?? "";
    const markdown_content = match[2] ?? "";

    try {
      const parsed = yaml.parse(yaml_content);
      const meta = (parsed && typeof parsed === "object" ? parsed : {}) as SkillMeta;
      return { meta, content: markdown_content.trim() };
    } catch {
      return { meta: {}, content: text.trim() };
    }
  }

  /**
   * 获取需要“始终自动加载”的技能 (always_load: true) 的全部 Prompt 内容。
   */
  get_always_skills_prompt(): string {
    const always_skills = this.skills.filter(
      (skill) => skill.active === true && skill.always_load === true
    );
    if (always_skills.length === 0) {
      return "";
    }

    const prompt_parts: string[] = ["# 常驻核心技能 (Always-loaded Skills)"];
    prompt_parts.push("你目前具备以下常驻核心技能，你可以随时使用它们：\n");

    for (const skill of always_skills) {
      prompt_parts.push(`## 技能：${skill.name}`);
      prompt_parts.push(`${skill.content}\n`);
    }

    return prompt_parts.join("\n");
  }

  /**
   * 构建可选技能列表的摘要信息，供 Agent 阅读并决定是否需要使用 `read_file` 工具查看详情。
   */
  build_skills_summary_prompt(): string {
    const available_skills = this.skills.filter(
      (skill) => skill.active === true && skill.always_load === false
    );
    if (available_skills.length === 0) {
      return "";
    }

    const prompt_parts: string[] = ["# 可选扩展技能 (Available Skills)"];
    prompt_parts.push(
      "以下技能扩展了你的能力。想使用某项技能前，请务必使用 `read_file` 工具读取相应路径下的 SKILL.md 文件学习具体用法。\n"
    );

    for (const skill of available_skills) {
      prompt_parts.push(`- **${skill.name}**: ${skill.description}`);
      prompt_parts.push(`  > 技能指南文件路径：\`${skill.path}\``);
    }

    return prompt_parts.join("\n");
  }

  /**为前端状态展示提取所有的技能摘要列表 */
  get_skills_summary():Array<{
    name: string;
    description: string;
    active: boolean;
  }> {
    return this.skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      active: skill.active,
    }));
  }
}
