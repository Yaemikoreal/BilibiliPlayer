## 这个 PR 做了什么

<!-- 一句话说清动机与结果；关联 issue 用 Closes #123 -->

## 改动类型

- [ ] feat：新工具 / 新能力
- [ ] fix：修复 Bug
- [ ] docs：文档
- [ ] test：测试
- [ ] refactor / chore：重构或其他

## 改了哪些文件

<!-- 例如：mcp_server.py（新增 bili_xxx）、README.md（工具表 +1） -->

## 验证方式

<!-- 贴出你实际跑过的命令与结果，例如： -->

```bash
python -m py_compile mcp_server.py bili_login.py
cd dsh-plugin && npm test
```

- [ ] Python 语法检查通过
- [ ] `cd dsh-plugin && npm test` 通过
- [ ] 涉及 UI 的改动已附浅色 / 深色截图
- [ ] 新增 / 修改工具已同步 README 与 docs（数量、分类、徽章）

## 影响面与风险

<!-- 是否碰了凭证处理、白名单、依赖、写操作类工具？有兼容性影响吗？ -->

## 自查清单

- [ ] 没有提交 `bili_credential.json`、`qrcode_login.png` 或任何真实账号数据
- [ ] 没有把本地未提交的调试代码 / 临时脚本带进来
- [ ] 提交信息符合 `<type>(<scope>): <中文描述>` 规范
- [ ] 文档只描述本 PR 已实现的功能
