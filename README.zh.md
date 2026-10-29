# dsh-skill-on-demand

[English](README.md) | 中文

DeepSeek Harness 会在每个会话里发布一次技能目录，之后每一次请求都会把它作为对话历史再发一遍。装了十几几十个技能时，这就是几千 token 的描述文字在每一轮重复发送，而其中大部分技能当前任务根本用不到。

这个插件把那份目录整个去掉，换成三个小工具。

## 做什么

| 之前 | 装上之后 |
| --- | --- |
| 一条消息列出所有技能名**和**描述，每次请求都带上 | 目录消息不再发布 |
| 模型要读完全部描述才知道需要什么 | `skill_list` 只返回技能**名字**；只有检索（带 `query`）才回描述 |
| 没有东西记录任务实际用了哪些 | `skill_pick` 记录本次会话保留的技能，其余忽略 |
| 每个技能正文都可达但没有上限 | `skill` 只按名字加载一个完整正文 |

每个会话只注入**一条**简短协议：列名字 → 判断任务需要的技能（≤5 个；候选不明确就问用户）→ `skill_pick` 固定 → 继续干活。不会重复注入；子代理会话不注入（工具照样能用，只是不为这条提示付钱）。

只有提示时模型经常当没看见，所以第一步还带**硬闸**：没选技能之前，普通工具调用会被拦下，并回一句写明 `skill_list` / `skill_pick` 的理由。每个会话最多拦 2 次，之后闸口永久打开。`skill_list`、`skill_pick`、`skill`、`ask_user`、`ask_user_question` 始终放行，子代理从不拦。

## 目录是怎么被去掉的

`@deepseek-ai/dsh-tool-skill` 只在 `ctx.tools.get('skill', agent)` 仍指向它自己注册的工具时才发布目录。本插件在每个 agent 自己的 scope 里注册同名 `skill` 工具（就近生效），那条检查因此不成立，目录不再发布。替代工具做同样的事——按精确名字加载一个技能的说明。

本来就没挂 `skill` 工具的极简 preset 不动：没有可替换的东西，也不该让刻意精简的 preset 悄悄多出工具。

## 安装

```sh
dsh plugin --profile web add dsh-skill-on-demand
```

装完重启 harness（bundle 在启动时加载）。

## 验证

开一个新会话随便问一句。第一轮应该出现 `skill_list` → `skill_pick`，并且没有 `<available_skills>` 块；`skill_list` 不带参数只回名字。

## 局限

- **有上限，不是绝对。** 闸口最多拦两次普通工具调用；两次都不理的模型照样能干活，而目录反正是没了，省 token 这部分结论不变。
- **老会话带着旧历史。** 装插件之前就已经发布过目录的会话，仍带着那条消息，外加一次官方插件的「没有可用技能」更正。想要干净状态请开新会话。
- **选择按会话。** 新会话重新判断一次，这是有意的：该留哪些技能取决于任务。
- **重名。** 如果某个 preset 已经在 agent 自己的层注册了 `skill`，注册会失败，插件退化成「选择工具可用、目录照旧」，不会把会话弄坏。

## 开发

`index.js` 是单个 Host 插件，没有构建步骤。`scripts/selftest.mjs` 对着 mock context 跑。请在**装好的包目录里**运行，这样模块解析才找得到 harness 自己的 `@deepseek-ai/*` 包：

```sh
node <profile>/node_modules/dsh-skill-on-demand/scripts/selftest.mjs
```

## 许可

MIT
