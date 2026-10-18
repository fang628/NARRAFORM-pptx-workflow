"""Typeset speaker notes as a readable, paginated PDF (no model/network calls)."""
import json
import os
import sys
from pathlib import Path
from xml.sax.saxutils import escape
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, KeepTogether
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfbase.cidfonts import UnicodeCIDFont


def build(source, output):
    data = json.loads(Path(source).read_text(encoding="utf-8"))
    font = "SpeakerCJK"
    fonts = Path(os.environ.get("WINDIR", "C:/Windows")) / "Fonts"
    for candidate in [fonts / "msyh.ttc", fonts / "simhei.ttf"]:
        try:
            pdfmetrics.registerFont(TTFont(font, str(candidate), subfontIndex=0))
            break
        except Exception:
            continue
    else:
        font = "STSong-Light"
        pdfmetrics.registerFont(UnicodeCIDFont(font))
    body = ParagraphStyle("Body", fontName=font, fontSize=11, leading=19, spaceAfter=11, textColor=HexColor("#313136"), wordWrap="CJK", splitLongWords=True, allowWidows=False, allowOrphans=False)
    title = ParagraphStyle("Title", parent=body, fontSize=15, leading=23, spaceBefore=18, spaceAfter=8, keepWithNext=True)
    meta = ParagraphStyle("Meta", parent=body, fontSize=9, leading=15, textColor=HexColor("#73737a"), spaceAfter=17)
    timing = ParagraphStyle("Timing", parent=meta, spaceAfter=8, keepWithNext=True)
    label = ParagraphStyle("Label", parent=meta, fontSize=9, spaceBefore=8, spaceAfter=5, textColor=HexColor("#57574c"), keepWithNext=True)
    def para(text, style=body):
        return Paragraph(escape(str(text)).replace("\n", "<br/>"), style)
    pages = data["pages"]
    story = [para(f'共 {len(pages)} 个PPT页 · 建议总时长约 {data["totalSeconds"] / 60:.1f} 分钟（按文字量估算）', meta)]
    material_names = {m["id"]: m["name"] for m in data.get("materials", [])}
    for i, page in enumerate(pages):
        seconds = page["seconds"]
        story += [para(f'{i+1:02d}. {page["title"]}', title),
                  para(f'对应PPT第{i+1}页 · 建议讲述 {seconds // 60}分{seconds % 60:02d}秒（按文字量估算）', timing)]
        if page["opening"]:
            story += [para("开场 / 本页观点", label), para(page["opening"])]
        story += [para("讲述正文", label)]
        story += [para(p) for p in page["paragraphs"][:-1]]
        ending = [para(page["paragraphs"][-1])]
        if page["transition"]:
            ending += [para("过渡 / 收束", label), para(page["transition"])]
        if page["evidence"]:
            ending += [Spacer(1, 9), para("材料索引：" + "；".join(material_names.get(m, m) for m in page["evidence"]), meta)]
        story.append(KeepTogether(ending))
    doc = SimpleDocTemplate(str(output), pagesize=A4, rightMargin=49, leftMargin=49, topMargin=61, bottomMargin=51, title=data["title"] + " · 演讲稿", author="NARRAFORM")
    count = [0]
    def decorate(c, doc):
        count[0] += 1
        c.saveState()
        c.setStrokeColor(HexColor("#deded7")); c.line(49, A4[1]-39, A4[0]-49, A4[1]-39)
        c.setFillColor(HexColor("#73737a")); c.setFont(font, 8)
        heading = data["title"]
        while pdfmetrics.stringWidth(heading, font, 8) > A4[0]-125:
            heading = heading[:-2] + "…"
        c.drawString(49, A4[1]-29, heading)
        c.drawString(49, 29, "演讲稿 / SPEAKER SCRIPT")
        c.drawRightString(A4[0]-49, 29, str(doc.page))
        c.restoreState()
    doc.build(story, onFirstPage=decorate, onLaterPages=decorate)
    return {"slides": len(pages), "pdfPages": count[0]}


if __name__ == "__main__":
    print(json.dumps(build(sys.argv[1], sys.argv[2]), ensure_ascii=False))
