# 飞书个人授权与 PDF 解析

## 飞书 OAuth 配置

1. 在飞书开放平台打开 TONA 使用的企业自建应用。
2. 在“安全设置 / 重定向 URL”中加入工具页返回的 `redirectUri`。生产环境示例：
   `https://tona-agent-studio.onrender.com/feishu/oauth/callback/<workspace-id>`
3. 在“权限管理”申请所需权限。日历至少需要 `calendar:calendar:readonly`；写入日程需要 `calendar:calendar`。TONA 会同时申请 `offline_access`，用于获得 refresh token。
4. 创建并发布应用版本，并确保应用已安装到目标企业。
5. 回到 TONA 的 Tools / Plugins 页面，在“日历与日程”旁点击“开始授权”。完成飞书同意页后，回调会把 user access token 和 refresh token 加密保存到当前 workspace。

建议在 Render 中配置独立的 `TONA_OAUTH_STATE_KEY`（至少 24 个随机字符）。若未配置，TONA 会从 `TONA_SECRETS_KEY` 或当前飞书 App Secret 派生签名密钥。生产环境必须继续配置 `TONA_SECRETS_KEY`，用于 token 静态加密。

电子表格、任务、通讯录等标为“需要飞书权限”的能力属于应用权限：需要管理员在飞书开放平台申请、发布版本并授权，不是个人 OAuth 按钮可以替代的。

## PDF 解析

上传 PDF 到当前 workspace 后，在文件页点击“读取”，系统会调用通用工具 `pdf_parse`：

- 本地解析 PDF 嵌入文本，不把文件发送到第三方；
- 返回页数、正文、文件 checksum 和 parser 来源；
- 支持指定页和最大字符数的 Runtime 调用；
- 如果 PDF 是纯扫描件且没有文字层，会返回 `PDF_OCR_REQUIRED`，提示转交已配置的 Unstructured/OCR executor；
- 密码保护文件会返回 `PDF_PASSWORD_REQUIRED`。

通用 Runtime API：`POST /api/runtime/tools/pdf_parse/run`，输入示例：

```json
{ "input": { "file_id": "file_xxx", "pages": [1, 2], "maxCharacters": 50000 } }
```