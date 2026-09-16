# 群聊 Agent preset（`group-host`）

这个目录是**运行时 preset 的源文件副本**，放在仓库里是为了能看 diff、能回滚。

真正生效的是用户根下的那份：

```text
${DSH_HOME:-~/.dsh}/.agent-presets/group-host/
  ├── preset.yml
  └── agent.cordis.yml
```

安装 / 更新：

```bash
# Windows PowerShell
Copy-Item .\presets\group-host\*.yml "$env:USERPROFILE\.dsh\.agent-presets\group-host\" -Force
# 拷完重启 DSH（preset 在进程启动时读取；roster 的 list() 虽然是实时读盘，
# 但已经建好的群聊会话不会换 preset——只有新建的群才用新组合）
```

- 只能改这里的副本，再拷过去；**不要直接编辑 `node_modules` 里 shipped 的 preset**（升级会覆盖）。
- 改完先做挂载校验（`agentPresets.standingKeyFor('group-host')` 不抛就是能挂），再重启 DSH。
- 本插件**硬依赖**它：`lib/store.js` 里的 `DEFAULT_GROUP_PRESET = 'group-host'`。目录不在时
  建群会当场失败并打印上面那条路径。

它的作用与设计见仓库根 `README.md` 的「群主 preset『群聊 Agent』」一节。
