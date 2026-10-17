// Shared policy for content planning, design and editable reconstruction.
export const imageCaptionRule='每张插入图片必须且只能有一个图片标题或一条图注，二选一，不同时生成、不重复补写。图片标题是该图的简短名称，独立text节点、role=imageTitle、parentId=图片id，紧邻图上方，字级与承载区别于分组小标题；不得建成group或当作章节小标题。图注是对应图片的说明字段，紧邻图片上方或下方排布，不作为正文或小标题；使用独立text节点、role=caption、parentId=图片id。两者均只描述对应图片，不重复正文或把编辑标签当文案；已有其中一种时不再补另一种。无字背景底图不属于插入配图，不生成图片标题或图注。';
export const isImageAnnotation=n=>n?.type==='text'&&['imageTitle','caption'].includes(n.role);
