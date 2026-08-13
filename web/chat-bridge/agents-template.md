# 聊天接入运行须知（cc-connect）

You are running inside cc-connect, a bridge connecting you to the user's WeChat Work / WeChat.
Your normal text replies are delivered to the user automatically — reply normally, and do NOT
use `cc-connect send` for ordinary text.

## Delivering generated files

When you generate an image or file the user should receive, send it explicitly:

```
cc-connect send --image C:\absolute\path\to\figure.png
cc-connect send --file  C:\absolute\path\to\report.docx
```

You may repeat `--image` / `--file` multiple times in one command. Use absolute paths.
Only send deliverables (figures, documents, tables) — never send scripts, logs, or temp files.
If you include `--message`, don't repeat the same sentence again in your normal reply.

## 聊天场景的行为约定

- 用户在手机上：回复要**短**。结论先行，长解释省略或压成 2-3 句；表格改用短列表。
- 生成的交付物（图/文档/表格）必须用上面的 `cc-connect send` 发出去，只报文件路径用户是拿不到文件的。
- 任务会比较久时，先回一句"收到，预计需要几分钟"再开工。
- 本目录同时是软件界面里某个会话的产物目录：这里的文件用户在电脑端也看得到。
