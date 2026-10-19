# 续订 · Xuding

一个本地优先的开源桌面订阅管理器。看清每月的长期负担、近期预计扣款，以及需要处理的试用和续费。

**Windows 优先 · 离线可用 · SQLite 本地存储 · MIT**

![总览界面（虚构演示数据）](docs/screenshots/overview.png)

![订阅详情（虚构演示数据）](docs/screenshots/detail.png)

## 当前功能

- **总览**：月均费用、年度折算、未来 30 天预计扣款、分类支出；总览不放新增按钮。
- **我的订阅**：新增、搜索、分类与状态筛选、归档；点击项目先进入详情。
- **订阅详情**：费用、计费基准日、续费状态、接下来三期计划、备注和服务商链接；点击“编辑订阅”进入编辑，保存或取消后回到详情。
- **扣款日历**：按月查看计划、按日期筛选，并进入详情。
- **计费规则**：按月 / 年及自定义间隔、免费试用、月底与闰年处理。
- **多币种**：人民币、美元、欧元、港币分别统计，不自动换汇。
- **桌面提醒**：明确开启后，在应用运行期间检查到期订阅，每期最多提醒一次。
- **备份**：JSON 导入与导出，格式校验、导入确认和事务写入。
- **窗口与导航**：浅灰标题栏保留系统窗口按钮；左上角按钮或 `Ctrl+B` 可平滑收起侧栏为图标栏，重启后记住状态，并遵循系统减少动态效果设置。

首次启动为空账本，不会把演示数据混进真实记录。v0.1 的金额均为**预计支出**，不代表已付款。关闭本地续费开关或归档不会替用户取消服务商扣费。

## 技术架构

```text
React 界面
    ↓ 类型化 API（contextBridge）
Electron preload：固定 IPC 通道
    ↓ 校验来源、数据结构与字段
Electron 主进程：订阅仓储 / 文件对话框 / 桌面提醒
    ↓
SQLite：订阅 / 修改快照 / 设置 / 提醒去重
```

| 层       | 选型                                             |
| -------- | ------------------------------------------------ |
| 桌面壳   | Electron 44                                      |
| 界面     | React 19、TypeScript、Lucide、原生 CSS           |
| 构建     | electron-vite、Vite                              |
| 本地存储 | SQLite，使用 Electron 内置 Node 的 `node:sqlite` |
| 数据校验 | Zod；数据库写入前再次校验                        |
| 测试     | Vitest、Playwright Electron                      |
| 安装包   | electron-builder / NSIS，Windows x64             |

完整设计和阶段边界见 [架构与开发方案](docs/architecture.md)。

## 本地开发

需要 Node.js **24 LTS**（24.0.0 及以上）、npm 和 Git。首次安装会下载 Electron。

```bash
npm ci
npm run dev
```

```bash
npm run check       # TypeScript + 计费 / SQLite 测试
npm run test:e2e    # 构建并启动真实 Electron 窗口验证主要流程
npm run build      # 生成 out/
npm start          # 运行构建产物
npm run pack       # 生成未安装的应用目录
npm run dist:win   # 生成 release/ 下的 Windows x64 NSIS 安装包
```

Electron 测试需要图形会话；GitHub Actions 使用 Windows runner。安装包暂未签名，正式发布的代码签名与自动更新将在后续版本配置。macOS / Linux 的适配和打包尚未验证。

## 数据与隐私

- 数据保存在 Electron 的 `userData` 目录，Windows 通常为 `%APPDATA%\xuding\xuding.db`，不在源码仓库内。
- 可设置 `XUDING_DATA_DIR` 为绝对目录以使用独立数据空间，适合测试或便携使用；未设置时使用默认目录。
- 无账号、遥测、远程数据库或订阅服务抓取。
- 数据库和 JSON 备份未加密，请自行保护本机账户与备份位置。
- 备份 v1 只包含当前订阅；应用偏好、修改快照和已发送提醒不随 JSON 导出。
- 导入按 ID 合并，相同 ID 覆盖，其他订阅保留；导入前可以先导出备份。
- 桌面提醒依赖应用运行与系统通知设置，退出应用或系统休眠时不会发送。

## 项目结构

```text
src/main/          应用生命周期、受限 IPC、SQLite 仓储
src/preload/       页面与主进程之间的类型化桥接
src/shared/        数据结构、校验、纯计费计算
src/renderer/src/  React 页面与样式
tests/             业务、存储与真实桌面流程测试
docs/              架构、功能边界与开发路线
.github/workflows/ 自动检查和 Windows 构建
```

## 下一步

托盘驻留与开机启动、提醒失败重试、已确认账单、价格生效日期、CSV 导入导出、签名发布与自动更新。详见架构文档中的里程碑。

欢迎通过 Issue 描述问题或提交 PR。贡献说明见 [CONTRIBUTING.md](CONTRIBUTING.md)。代码遵循 [MIT License](LICENSE)。
