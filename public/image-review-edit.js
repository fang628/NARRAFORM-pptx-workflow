// Only current-image findings belong in an image adjustment, never request failures or history.
export function imageReviewIssues(image){
  const check=image?.previewReview,review=image?.review;
  if(['pending','failed','cancelled','not_required'].includes(check?.status))return [];
  const list=v=>Array.isArray(v)?v:[];
  const values=[...list(check?.issues??review?.issues),...list(check?.warnings??review?.warnings)];
  const transport=/接口|ENOTFOUND|EAI_AGAIN|terminated|JSON|请求.*(?:失败|取消|超时)|检查.*(?:未完成|未返回|无效|响应|失败|取消)|Cannot set property/i;
  return [...new Set(values.filter(v=>typeof v==='string').map(v=>v.trim()).filter(v=>v&&!transport.test(v)))];
}

export const imageReviewKey=image=>JSON.stringify(imageReviewIssues(image));
