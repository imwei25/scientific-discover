"""检索相关性排序与去噪回归测试(E3, 离线零额度)。

运行: .venv\\Scripts\\python.exe test_literature_rank.py
验证:
  - _query_terms 提取主题词, 剔除布尔逻辑/字段标签;
  - _is_noise 识别更正/勘误/评论等非研究条目;
  - _merge_all 去噪 + 词面相关性排序(切题文献顶到前面)。
"""
import sys

from app.literature import _query_terms, _merge_all, _is_noise, _lexical_rel


def main() -> None:
    failed = 0

    def check(cond, msg):
        nonlocal failed
        if not cond:
            failed += 1
            print(f"  FAIL: {msg}")

    # 1) 主题词提取
    terms = _query_terms(["diabetic nephropathy AND (SGLT2 OR empagliflozin)[Title/Abstract]"])
    check("diabetic" in terms and "nephropathy" in terms and "sglt2" in terms, "缺主题词")
    check("and" not in terms and "or" not in terms and "title" not in terms, "未剔除布尔/字段标签")
    check(_query_terms([]) == set(), "空检索式应得空集")

    # 2) 去噪识别
    for noisy in ("Erratum: A study", "Author Correction: foo", "Comment on X",
                  "Retraction Note: bar", "Reply to Smith et al"):
        check(_is_noise({"title": noisy}), f"未识别噪声: {noisy}")
    check(not _is_noise({"title": "SGLT2 inhibitors in diabetic nephropathy"}), "误判正常文献为噪声")

    # 3) 词面相关性: 切题 > 离题
    on = {"title": "SGLT2 empagliflozin in diabetic nephropathy", "abstract": "diabetic nephropathy sglt2"}
    off = {"title": "Unrelated cancer immunotherapy", "abstract": "oncology"}
    check(_lexical_rel(on, terms) > _lexical_rel(off, terms), "切题词面分应高于离题")
    check(_lexical_rel(off, set()) == 0.5, "无主题词应中性 0.5")

    # 4) 合并: 去噪 + 把切题文献排到第一
    src = [[
        {"title": "Unrelated cancer immunotherapy review", "abstract": "oncology", "pmid": "1", "url": "u1", "source": "pubmed"},
        {"title": "SGLT2 empagliflozin in diabetic nephropathy", "abstract": "diabetic nephropathy sglt2", "pmid": "2", "url": "u2", "source": "pubmed"},
        {"title": "Erratum: SGLT2 diabetic nephropathy", "abstract": "x", "pmid": "3", "url": "u3", "source": "pubmed"},
    ]]
    out = _merge_all(src, 10, terms)
    titles = [p["title"] for p in out]
    check(all("Erratum" not in t for t in titles), "噪声未被剔除")
    check(len(out) == 2, f"应剩 2 篇, 实得 {len(out)}")
    check(titles[0].startswith("SGLT2"), f"切题文献应排第一: {titles}")

    if failed:
        print(f"\n{failed} 个用例失败")
        sys.exit(1)
    print("ALL LITERATURE-RANK TESTS PASSED")


if __name__ == "__main__":
    main()
