> Source: `SKILL.md` top-of-file deployment block (`<project_path>` convention, `--dir .`, CJK fonts) — moved verbatim. Read before creating a project or choosing fonts; `SKILL.md` keeps a one-line summary.

> **`<project_path>` 取在哪里（本部署的硬约定）**：**当前工作目录就是本会话的产物目录**
> （网关建会话时已把 opencode 的 session.directory 指到那里），所以本文档下面所有命令里的
> `<project_path>`，一律取**当前目录下的 `<项目名>/`**——直接用相对路径，别再拼任何 `outputs/…` 前缀。
> 于是工程目录、`sources/`、`images/`、`templates/`、导出的 .pptx 全都落在会话产物目录下，
> 既能出现在界面的"产出"侧栏，也随数据卷持久保存。
>
> **绝不要**把工程建到 `${REPO_ROOT:-/app}`（仓库根）下：那里是**应用安装目录**，
> 升级 / 重装 / 更新技能包都可能整片覆盖，**工程连同已导出的 PPT 会一起蒸发**，
> 而且全程不出现在"产出"侧栏里。
> **建工程时必须显式传 `--dir .`**：`project_manager.py init` 的 `base_dir` 默认是 `cwd/projects`（脚本 116 行），
> 不传 `--dir` 就会多套一层 `projects/`，与上面的约定不一致。断点续做口令同理用相对项目名。
>
> 注：本文档里 `<project_name>` 等尖括号写法都是**占位符**，实际执行前替换成真实值
> （直接照抄进 shell 会因 `<` `>` 是重定向符而报错）。
>
> **中文字体（本容器的现实，读一遍免踩坑）**：容器里【没有】`Microsoft YaHei` / `SimHei` /
> `SimSun` / `KaiTi` 等 Windows 字体文件，但**照常按下方 references（strategist §g 等）的
> Windows 家族名选字体即可**——镜像内置 fontconfig 别名（`/etc/fonts/conf.d/65-windows-cjk-aliases.conf`）
> 把这些名字解析到容器真实字体（黑体系→`WenQuanYi Micro Hei`、宋体/仿宋系→`AR PL SungtiL GB`、
> 楷体→`AR PL KaitiM GB`，全部单文件字体；**刻意不用**同样已装的 Noto CJK SC——本镜像的
> LibreOffice 对多 face TTC 有索引缺陷，指过去会渲染成日文字形，实测锚定），LibreOffice
> 预览渲染的是正确的简体字形；pptx 里记录的仍是 Windows 字体名，用户下载后在自己机器上
> 打开效果最佳。因此：**①** 不要因为 `fc-list` 查不到 YaHei 就换用别的字体名或停下报错；
> **②** **禁止在容器里现装字体**（`apt install` / 下载 ttf 塞 `~/.fonts`）——装进容器可写层，
> 重建容器即消失，还会挤占共享宿主磁盘；若确实缺某个字形，如实告知用户该字体不在预装清单、
> 请平台管理员改镜像。
