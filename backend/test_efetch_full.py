"""literature.efetch_full 单测：验证 XML → 结构化 authors 的解析
(family/given 分离，复姓不拆散)。不联网。"""
from __future__ import annotations

from app.literature import _parse_efetch_xml


_SAMPLE_XML = """<?xml version="1.0"?>
<PubmedArticleSet>
  <PubmedArticle>
    <MedlineCitation>
      <PMID>38891839</PMID>
      <Article>
        <ArticleTitle>Deciphering the Complex Immunopathogenesis of Alopecia Areata</ArticleTitle>
        <Journal>
          <ISSN>1422-0067</ISSN>
          <Title>International Journal of Molecular Sciences</Title>
          <JournalIssue><PubDate><Year>2024</Year></PubDate></JournalIssue>
        </Journal>
        <AuthorList>
          <Author>
            <LastName>Šutić Udović</LastName>
            <ForeName>Ivana</ForeName>
            <Initials>I</Initials>
          </Author>
          <Author>
            <LastName>Hlača</LastName>
            <ForeName>Nika</ForeName>
            <Initials>N</Initials>
          </Author>
        </AuthorList>
      </Article>
    </MedlineCitation>
    <PubmedData>
      <ArticleIdList>
        <ArticleId IdType="pubmed">38891839</ArticleId>
        <ArticleId IdType="doi">10.3390/ijms25115652</ArticleId>
      </ArticleIdList>
    </PubmedData>
  </PubmedArticle>
</PubmedArticleSet>
"""


def test_parse_efetch_xml_preserves_multipart_family_name():
    papers = _parse_efetch_xml(_SAMPLE_XML)
    assert len(papers) == 1
    p = papers[0]
    assert p["pmid"] == "38891839"
    assert p["title"] == "Deciphering the Complex Immunopathogenesis of Alopecia Areata"
    assert p["journal"] == "International Journal of Molecular Sciences"
    assert p["doi"] == "10.3390/ijms25115652"
    assert p["year"] == "2024"
    # 关键：复姓 "Šutić Udović" 完整保留在 family，不被 ForeName 首字母覆盖
    assert p["authors"] == [
        {"family": "Šutić Udović", "given": "Ivana"},
        {"family": "Hlača", "given": "Nika"},
    ]


def test_parse_efetch_xml_falls_back_to_initials_when_no_forename():
    xml = """<?xml version="1.0"?>
<PubmedArticleSet><PubmedArticle><MedlineCitation>
  <PMID>1</PMID>
  <Article>
    <ArticleTitle>T</ArticleTitle>
    <Journal><Title>J</Title></Journal>
    <AuthorList>
      <Author><LastName>King</LastName><Initials>B</Initials></Author>
    </AuthorList>
  </Article>
</MedlineCitation></PubmedArticle></PubmedArticleSet>"""
    papers = _parse_efetch_xml(xml)
    assert papers[0]["authors"] == [{"family": "King", "given": "B"}]


if __name__ == "__main__":
    test_parse_efetch_xml_preserves_multipart_family_name()
    test_parse_efetch_xml_falls_back_to_initials_when_no_forename()
    print("ALL EFETCH_FULL TESTS PASSED")
