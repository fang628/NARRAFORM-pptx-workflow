"""Convert trusted-size LaTeX to native Office Math, never a bitmap."""
import json, sys, xml.etree.ElementTree as ET
from latex2mathml.converter import convert as latex_to_mathml
from mathml2omml import convert as mathml_to_omml

M='http://schemas.openxmlformats.org/officeDocument/2006/math'
ET.register_namespace('m',M)
def convert(latex):
    if not isinstance(latex,str) or not 0<len(latex)<=4000:
        raise ValueError('公式长度无效')
    result=mathml_to_omml(latex_to_mathml(latex))
    root=ET.fromstring(result.replace('<m:oMath>','<m:oMath xmlns:m="'+M+'">',1))
    if root.tag!='{'+M+'}oMath':
        raise ValueError('公式没有转换为Office Math')
    return ET.tostring(root,encoding='unicode')

if __name__=='__main__':
    try:
        items=json.loads(sys.stdin.buffer.read().decode('utf-8'))
        if not isinstance(items,list) or len(items)>300:
            raise ValueError('公式数量无效')
        print(json.dumps([convert(item) for item in items],ensure_ascii=True))
    except Exception as error:
        print(str(error),file=sys.stderr)
        sys.exit(1)
