# 参与开发

使用 Node.js 24 LTS 和 npm。执行 `npm ci` 后用 `npm run dev` 启动桌面开发环境。

提交前运行：

```bash
npm run check
npm run test:e2e
```

计费变更需补充边界测试；存储变更需明确迁移方案；新增系统能力必须经由受限 preload API，不向 renderer 暴露任意 IPC、SQL 或文件操作。

界面遵循已确认流程：列表进入详情，详情提供编辑，保存 / 取消回到详情；总览不提供新增订阅按钮。

Issue 请描述系统版本、复现步骤、预期与实际行为。日志或截图请去掉个人订阅、文件路径或凭据。请勿提交本地数据库或真实备份。

依赖变更需同步 package-lock.json。公共代码采用 MIT 许可。
