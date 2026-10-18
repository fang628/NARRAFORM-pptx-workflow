import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

test('透明素材收紧边界；棋盘格仅去背景并保留内部白色，复杂底色拒绝自动处理',async()=>{
  const script=`import sys,json
sys.path.insert(0,sys.argv[1])
from cutout_alpha import prepare_cutout
from PIL import Image,ImageDraw
im=Image.new('RGBA',(204,128),'white');d=ImageDraw.Draw(im)
for y in range(0,128,8):
 for x in range(0,204,8):
  if (x//8+y//8)%2:d.rectangle((x,y,x+7,y+7),fill=(242,242,242,255))
d.ellipse((62,24,142,104),fill=(80,140,220,255));d.ellipse((82,44,122,84),fill='white')
out,report=prepare_cutout(im)
assert report['mode']=='neutral-background-matte'
assert out.width<100 and out.height<100
assert out.getpixel((out.width//2,out.height//2))==(255,255,255,255)
assert out.getpixel((0,0))[3]==0
transparent=Image.new('RGBA',(204,128),(0,0,0,0));ImageDraw.Draw(transparent).rectangle((80,30,120,90),fill=(80,140,220,255))
t,r=prepare_cutout(transparent);assert r['mode']=='provider-alpha' and t.width<60 and t.height<80
for color in ['red','white']:
 try:prepare_cutout(Image.new('RGBA',(100,100),color))
 except ValueError:pass
 else:raise AssertionError('Unsafe background accepted')
print(json.dumps({'checkerboard':report,'transparent':r}))`;
  const {stdout}=await promisify(execFile)(path.resolve('.venv/Scripts/python.exe'),['-c',script,path.resolve('tools')],{windowsHide:true,timeout:30000});
  assert.equal(JSON.parse(stdout).checkerboard.hasTransparency,true);
});
