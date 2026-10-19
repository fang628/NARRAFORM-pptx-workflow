const h=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function favoriteStyleButton(p,styleId){
  if(!p.styleFavoritesEnabled||!(p.styleRegistry||[]).some(r=>r.id===styleId&&!r.deletedAt&&r.origin!=='preset'))return '';
  const favoriteId=p.starredStyleIds?.[styleId],starred=!!favoriteId;
  return `<button type="button" class="text-button style-star ${starred?'is-starred':''}" ${starred?`data-unfavorite-style="${h(favoriteId)}"`:`data-favorite-style="${h(styleId)}"`} aria-pressed="${starred}" title="${starred?'取消跨项目收藏':'收藏后可在其他项目选用'}" ${p.task?.status==='running'?'disabled':''}><span aria-hidden="true">${starred?'★':'☆'}</span> ${starred?'已收藏':'收藏风格'}</button>`;
}
export function favoriteStyleOptions(p){
  return p.styleFavorites?.length?'<optgroup label="★ 跨项目收藏">'+p.styleFavorites.map(s=>`<option value="${h(s.id)}">${h(s.definition.name)}</option>`).join('')+'</optgroup>':'';
}
export function styleFavoritesPanel(p){
  if(!p.styleFavoritesEnabled)return '';
  return `<section class="style-favorites"><h4>★ 收藏风格 <small>${p.styleFavorites?.length||0}</small></h4>${p.styleFavoritesWarning?`<p class="subtle">${h(p.styleFavoritesWarning)}</p>`:''}<p class="subtle">跨项目保存。在「更换风格」中选用收藏，沿用配色、字体、框形与装饰，按新材料生成画面。</p><div class="favorite-style-grid">${(p.styleFavorites||[]).map(s=>`<article><div><i style="--swatch:${/^#[\da-f]{6}$/i.test(s.definition.coreColor)?s.definition.coreColor:'#cccccc'}"></i><strong>${h(s.definition.name)}</strong><button type="button" class="text-button" data-unfavorite-style="${h(s.id)}" aria-label="取消收藏 ${h(s.definition.name)}" ${p.task?.status==='running'?'disabled':''}>取消收藏</button></div><p>${h(s.definition.description)}</p><details><summary>风格定义</summary><p>${h(s.definition.style)}</p><p>${h(s.definition.typography)}</p><p>${h(s.definition.frames)}</p><p>${h(s.definition.decoration)}</p><p>${h(s.definition.layoutLanguage)}</p></details></article>`).join('')}</div></section>`;
}
