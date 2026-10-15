# Askdown · 边读边问

文档是主体，AI 是文档里的一种能力。

在哪儿困惑就在哪儿用 `??` 提问，回答直接长在原地；最后一键把散落的问答整理成一份结构化笔记。所有内容都是普通的 Markdown 文件，用 Obsidian、Typora、GitHub 打开也能正常显示。

## 用法

| 操作 | 效果 |
| --- | --- |
| 段落以 `??` 开头，在末尾按 `Enter` | 变成问题块并提问，回答以回答块插在下面 |
| 在任意段落按 `Ctrl/⌘ + Enter` | 在下方插入一个空的问题块 |
| 在问题块里按 `Enter` 或点「提问」 | 提问（已有回答时重新生成） |
| `Shift + Enter` | 段内换行 |
| 回答块上的按钮 | 收起、重问、并入正文（变成你自己的文字）、删除；生成中可以停止 |
| 右侧「整理问答」 | 把文档里所有问答归并成「核心概念 / 要点 / 还没搞懂的」，保存为同名的 `.notes.md` |

### 文件格式

问题和回答保存为 Obsidian 风格的 callout，不依赖 Askdown 也能读：

```markdown
> [!question]
> 如果那个下午没有翻译活，机会成本还是三百元吗？

> [!ai]
> 不是。机会成本只算你实际可选的次优选项……
```

文件库里其他 Obsidian callout（`[!note]`、`[!tip]` 等）也会以块的形式显示，并原样保存。

### 模型

在「设置」里选择：

- **Claude**：填 Anthropic API Key 和模型名。
- **OpenAI 兼容接口**：内置 DeepSeek、OpenAI、Ollama（本地模型）预设，也可以填任意兼容地址（通义、Kimi、智谱等）。
- **演示**：不调用模型，用来熟悉界面。

API Key 保存在本机应用配置目录的 `settings.json` 里，不会写进文件库。

### 提示词

提问和整理用的提示词是文件库里 `.askdown/prompts/ask.md` 和 `tidy.md`，第一次使用时自动生成。可以在「设置 → 编辑提问模板 / 编辑整理模板」里直接修改。可用变量：

- 提问：`{{question}}`、`{{anchor}}`（问题前最近的一段）、`{{document}}`（整篇文档，问题位置标为「【用户在这里提问】」）
- 整理：`{{title}}`、`{{head}}`（文档开头）、`{{notes}}`（已有笔记）、`{{qa}}`（全部问答）

## 开发

需要 Node.js 20+ 和 Rust（[Tauri 的系统依赖说明](https://tauri.app/start/prerequisites/)）。

```bash
npm install
npm run tauri dev     # 启动桌面应用（开发模式）
npm run tauri build   # 打包安装程序
```

只改界面时可以不启动 Tauri：`npm run dev` 后在浏览器打开 `http://localhost:1420`，会使用存在 localStorage 里的演示文件库。

### 技术栈

- **Tauri 2**：桌面外壳。Rust 端只负责读写文件和保存设置（`src-tauri/src/lib.rs`）。
- **React + TypeScript + Vite**：界面。
- **Milkdown 7**（基于 ProseMirror）：所见即所得的 Markdown 编辑器。
- **Vercel AI SDK**：统一调用 Anthropic 和 OpenAI 兼容接口；桌面端经 Tauri HTTP 插件发请求，没有跨域限制。

### 代码结构

```
src/
  editor/
    callout.ts        callout 节点：Markdown ⇄ 编辑器的解析和序列化
    qa.ts             提问、流式写入回答、回答块按钮、收集问答对
    createEditor.ts   组装 Milkdown
  ai/
    providers.ts      模型调用与错误说明
    prompts.ts        提示词模板（默认值、读取、变量替换）
    actions.ts        提问和整理的具体调用
  fs/                 文件库：Tauri 实现和浏览器演示实现
  components/         侧栏、编辑区、整理面板、设置
  App.tsx
src-tauri/            Rust 端和应用配置
```

## 路线图

- [ ] 文件被外部修改时自动重新载入
- [ ] 文件重命名、删除、文件夹树
- [ ] 页边批注模式：AI 在页边追问，正文只属于你
- [ ] 选中一段文字直接提问
- [ ] 跨文档关联（「你在另一篇笔记里问过类似的问题」）
- [ ] API Key 存入系统钥匙串

## 许可

MIT
