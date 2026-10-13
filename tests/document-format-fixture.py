import pathlib,sys,zipfile
import pymupdf
root=pathlib.Path(sys.argv[1]);root.mkdir(parents=True,exist_ok=True)
ns='http://schemas.openxmlformats.org/wordprocessingml/2006/main'
math='http://schemas.openxmlformats.org/officeDocument/2006/math'
document=f'''<w:document xmlns:w="{ns}" xmlns:m="{math}"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading"/></w:pPr><w:r><w:t>报告标题</w:t></w:r></w:p>
<w:p><w:r><w:t>普通😀文本 </w:t></w:r><w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:t>加粗内容</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t> 斜体</w:t><w:br/><w:t>换行后</w:t><w:tab/><w:t>制表后</w:t></w:r></w:p>
<w:p><w:r><w:rPr><w:rStyle w:val="Emphasis"/></w:rPr><w:t>继承斜体</w:t></w:r><w:r><w:rPr><w:i w:val="0"/></w:rPr><w:t>不斜体</w:t></w:r></w:p>
<w:p><w:r><w:t>公式：</w:t></w:r><m:oMath><m:f><m:num><m:r><m:t>a</m:t></m:r></m:num><m:den><m:r><m:t>b</m:t></m:r></m:den></m:f><m:r><m:t>=</m:t></m:r><m:sSup><m:e><m:r><m:t>x</m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup></m:oMath></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>名称</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>数值</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>样本A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>42</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
</w:body></w:document>'''
styles=f'''<w:styles xmlns:w="{ns}"><w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="24"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:rPr><w:sz w:val="24"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading"><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="48"/></w:rPr></w:style><w:style w:type="character" w:styleId="Emphasis"><w:rPr><w:i/></w:rPr></w:style></w:styles>'''
with zipfile.ZipFile(root/'formatted.docx','w') as z:
    z.writestr('word/document.xml',document);z.writestr('word/styles.xml',styles)
(root/'formatted.md').write_text('''# 项目报告

普通文字，**加粗内容**与*斜体内容*。
换行后一行。  
强制换行。

| 名称 | 数值 |
| --- | --- |
| 样本A | **42** |
| 公式 | $x^2$ |

行内公式 $E=mc^2$，保持上下标。

$$
\\frac{a}{b}=\\sqrt{x}
$$

<script>alert("unsafe")</script>
''',encoding='utf-8')
with pymupdf.open() as pdf:
    p=pdf.new_page(width=500,height=500)
    p.insert_text((30,40),'Report title',fontsize=24,fontname='hebo')
    p.insert_text((30,75),'Regular text',fontsize=12)
    p.insert_text((30,100),'Italic text',fontsize=12,fontname='heit')
    for y in [140,180,220]:p.draw_line((30,y),(330,y))
    for x in [30,180,330]:p.draw_line((x,140),(x,220))
    for x,y,text in [(40,165,'Name'),(190,165,'Value'),(40,205,'Sample A'),(190,205,'42')]:p.insert_text((x,y),text,fontsize=12)
    p.insert_text((30,270),'E = mc',fontsize=14);p.insert_text((80,263),'2',fontsize=9)
    pdf.save(root/'formatted.pdf')
