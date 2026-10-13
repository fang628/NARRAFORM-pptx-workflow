import {requireThemeAssetForPage,themeUseForPage} from './theme-assets.mjs';

// Only registered, wordless foundations can become slide backgrounds.
// The generated full-page preview remains a comparison reference, never a background.
export function slideBackground(p,index){
  const asset=requireThemeAssetForPage(p,index,p.selectedTheme);
  const material=p.materials.find(m=>m.id===asset.materialId);
  if(!material||material.purpose!=='workflow-background'||material.sha256!==asset.previewHash)throw Error('页面底图登记或哈希不一致，请在03重新检查底图');
  return {id:material.id,sha256:asset.previewHash,theme:p.selectedTheme,use:themeUseForPage(p,index)};
}
