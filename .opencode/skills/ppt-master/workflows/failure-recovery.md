---
description: Failure recovery matrix for PPT Master generation routes
---

# Failure Recovery Matrix

Central recovery rules for common PPT Master failures. Route-specific workflow files may add narrower handling, but must not weaken these stop/continue decisions.

**Hard rule**: A failed required artifact blocks the next gate. A failed convenience surface falls back to the canonical channel and does not block generation.

---

## 1. Recovery Matrix

| Failure point | Blocking | Automatic recovery | User intervention | Resume entry |
|---|---:|---|---|---|
| Confirm UI launch failure | No | Re-check `confirm_ui/result.json` once, then use chat fallback | No | `SKILL.md` Step 4 chat confirmation |
| Confirm UI wait timeout | No, if no final result yet | Re-check `result.json` once; keep server cleanup mandatory | Only if user still wants the page | Step 4 same stage or chat fallback |
| Confirm UI Stage 1 completed then interrupted | Yes until Stage 2 is written/confirmed | Read existing Stage 1 `result.json`, write Stage 2 recommendations, then `--wait-only --wait-stage stage2` | Usually no | Step 4 Stage 2 write/wait |
| Missing final confirmation | Yes | None | User must confirm or change the values | Step 4 final confirmation |
| Formula rendering provider failure | No if fallback succeeds; yes if selected formulas remain missing | Provider fallback chain; otherwise mark affected rows manual only if acceptable | Only if rendered formula files are required and unavailable | Step 4 formula rendering / Step 7 image readiness gate |
| AI image generation failure | No | Retry once through the confirmed path, then mark row `Needs-Manual` | Only when missing files are required before export | Step 5 / Step 7 image readiness gate |
| Web image search/download failure | No | Adjust query/source per image-searcher rules, then mark `Needs-Manual` if unresolved | Only if the resource is required and no acceptable substitute exists | Step 5 |
| Slice sheet missing | Yes for derived slice rows | Wait for parent sheet; run `slice_images.py`; rerun image analysis | Yes when sheet was manual/offline | Step 5 slice handling / Step 7 image readiness gate |
| Residual `Pending` or `Failed` image row before Executor | Yes | Re-run path or mark `Needs-Manual` | Only if file must be supplied manually | Step 5 terminal-state check |
| User replaces/adds images after analysis | No | Re-run `analyze_images.py` before reading image facts | No | Step 4/5/6 image-fact read |
| Live preview fails to start | No | **本部署：预期状态，不是故障** —— 直接继续生成，不排查、不播报 5050 地址、不停下问用户 | **No（本部署永不升级）** | Step 6 覆盖规则 |
| Live preview closed by user | No | Continue generation | **No** | 本部署已停用 `live-preview`，**即使用户要求也不要重启**；改为引导下载 `.pptx`、改稿走聊天描述 |
| Browser annotations submitted during generation | No | 本部署不会有浏览器注解（用户打不开编辑器）；若用户口头描述修改，直接改 `svg_output/` 下 SVG 后重新导出 | No | 本部署 `live-preview` 已停用 |
| `svg_quality_checker.py` error | Yes | Fix the affected SVG, then rerun checker | No unless required asset is missing | Step 6 Visual Construction |
| `svg_quality_checker.py` warning | No | Fix when straightforward; otherwise acknowledge residual risk | No | Step 6 warning handling |
| Missing `notes/total.md` | Yes | Generate speaker notes before Step 7 | No | Step 6 Logic Construction |
| Step 7 image readiness missing manual files | Yes | None for manual assets; list required filenames and prompts | Yes | Step 7 image readiness gate |
| `total_md_split.py` failure | Yes | Fix notes format/path, rerun only Step 7.1 | Usually no | Step 7.1 |
| `finalize_svg.py` failure | Yes | Fix SVG/assets, rerun Step 7.2 | Only if source asset is missing | Step 7.2 |
| `svg_to_pptx.py` failure | Yes | Fix conversion issue, rerun Step 7.3 | Only if required artifact is missing | Step 7.3 |
| Export succeeds but user wants direct browser edits re-exported | No | Rerun Step 7.2 and Step 7.3 after applied edits | No | Post-export live-preview handling |

---

## 2. Stop/Continue Rules

| Condition | Action |
|---|---|
| Required gate artifact missing | Stop at that gate and name the missing artifact. |
| Optional workflow not explicitly requested | Do not run it as recovery. |
| Convenience UI/server failure | Fall back to chat or continue without the surface. |
| Derived artifact stale | Regenerate it from its owning source. |
| Manual image asset missing at Step 7 | Pause and list exact filenames; resume only after files exist. |
| Checker/export error | Fix the source artifact, then rerun the failed command and downstream commands only. |

**Forbidden - silent downgrade**: Do not skip a required gate because a downstream command might tolerate the missing file. Fix or pause at the owning gate.

---

## 3. Resume Pointers

| Last good state | Resume from |
|---|---|
| Stage 1 confirmation exists, Stage 2 missing | 写出 Stage 2 候选后**在对话里**呈现并等用户回复（本部署确认页已停用，**不要**执行 `confirm_ui/server.py`；其它部署才用 `--wait-only --wait-stage stage2`） |
| `design_spec.md` and `spec_lock.md` complete, split mode selected | [`resume-execute`](./resume-execute.md) |
| Images acquired but SVGs not started | `SKILL.md` Step 6 |
| SVGs complete and checker passed, notes missing | Step 6 Logic Construction |
| SVGs and notes complete | Step 7.1 |
| Step 7.1 complete, export not complete | Step 7.2 |
| Step 7.2 complete, PPTX not complete | Step 7.3 |
| Browser annotations saved after export | [`live-preview`](./live-preview.md) Step 2 |

**Default - resume at the owning failed step**: Do not restart the planning session or regenerate prior artifacts unless the owning source has changed.
