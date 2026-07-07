---
name: data-analysis
description: 用于任何数据分析、统计计算、画图、读写 CSV/Excel 的任务。使用容器内已装好的 Python（pandas / numpy / scipy / matplotlib / scikit-learn / seaborn / statsmodels）。当用户上传数据文件或要求分析、统计、可视化时使用。
---

# 数据分析技能（服务器/容器版）

容器里已经装好科学计算包，直接用系统 `python3` 运行。

## 运行方式
把代码写到一个 `.py` 文件，再用 bash 执行：
```
python3 analysis.py
```
已装：pandas、numpy、scipy、matplotlib、scikit-learn、seaborn、statsmodels、openpyxl。

## 约定
- 输入数据文件在工作目录，或 `uploads/` 目录里。
- **所有产出（图表 PNG、结果 CSV/Excel）写到 `outputs/` 目录**，方便前端用户下载。
- 画图用无界面后端：脚本开头 `import matplotlib; matplotlib.use("Agg")`，再 `plt.savefig("outputs/xxx.png", dpi=150, bbox_inches="tight")`。
- 分析完，用一段话向用户总结关键结论 + 列出生成的文件路径。
