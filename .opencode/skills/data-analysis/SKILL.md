---
name: data-analysis
description: 用于任何数据分析、统计计算、画图、读写 CSV/Excel 的任务。使用项目自带的 Python 虚拟环境（内含 pandas / numpy / scipy / matplotlib / scikit-learn / seaborn / statsmodels）。当用户上传数据文件或要求分析、统计、可视化时使用。
---

# 数据分析技能

本项目自带一个已配置好的 Python 虚拟环境，装了科学计算包。**运行 Python 必须用这个解释器**，不要用系统 `python`（系统没装 Python）。

## 解释器
```
backend/.venv/Scripts/python.exe
```
已安装：pandas、numpy、scipy、matplotlib、scikit-learn、seaborn、statsmodels、openpyxl。

## 运行方式
把代码写到一个 `.py` 文件，再用 bash 执行：
```
backend/.venv/Scripts/python.exe analysis.py
```

## 约定
- 输入数据文件在工作目录，或 `uploads/` 目录里。
- **所有产出（图表 PNG、结果 CSV/Excel）写到 `outputs/` 目录**，方便前端用户下载。
- 画图用无界面后端：脚本开头 `import matplotlib; matplotlib.use("Agg")`，再 `plt.savefig("outputs/xxx.png", dpi=150, bbox_inches="tight")`。
- 分析完，用一段话向用户总结关键结论 + 列出生成的文件路径。
