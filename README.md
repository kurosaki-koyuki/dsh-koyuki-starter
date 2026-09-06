# dsh-koyuki-starter

DeepSeek Harness (dsh) + better-sidebar 的一键运行按钮插件：在资源管理器/编辑器里给脚本文件加一个**粉色 ▶**，点了就在 better-sidebar 的终端里运行。

| 文件类型 | 运行方式 |
|---|---|
| `.py` | `python <file>` |
| `.R` / `.r` | `Rscript <file>` |
| `.bat` / `.cmd` | `cmd /d /c <file>` |

## 功能

- 单个粉色 ▶：点击即在**当前可见终端**里自动敲命令并执行（cwd = 文件所在目录）
- 若当前没有任何终端，会自动在底部面板开一个终端再执行
- 实在无法自动输入时，把命令复制到剪贴板并提示
- 界面提示中英双语，跟随 DSH 界面语言（html lang / 浏览器语言）
- 纯 DOM 覆盖，不改 better-sidebar 源码

## 安装

```sh
# 方式一：npm（若已发布）
dsh plugin --profile web add dsh-koyuki-starter

# 方式二：GitHub
dsh plugin --profile web add github:<YOUR_GITHUB_USERNAME>/dsh-koyuki-starter

# 方式三：本地目录
dsh plugin --profile web add file:C:/路径/到/dsh-koyuki-starter
```

装完重启 `dsh web`，在 better-sidebar 打开工作区即可看到按钮。

## 卸载

```sh
dsh plugin --profile web remove dsh-koyuki-starter
```

## 说明 / 安全

- 本插件会按你的用户权限在本机执行 Python / Rscript / cmd 命令，仅限上述扩展名的真实文件。
- host 端自带 `/dsh-koyuki-starter/*` 路由（备用）；当前 UI 以 DOM 注入运行，不依赖该路由。
- 若按钮没出现：Ctrl+Shift+R 硬刷新；仍不行重启 dsh web。

## 许可证

MIT — 见 [LICENSE](LICENSE)。