# 项目内风格与规范库

本目录是PPT Agent实际使用的规范副本，当前用户要求优先。它已按网页01–05流程整理，不要求执行原skill命令行状态机；原始skill目录不受修改。

- 风格与配色：[风格指南](stages/13-design/references/style-guide.md)、[A–F原始令牌](stages/13-design/references/style-tokens.json)。完整预设与仅借配色分开处理。
- 提示词：[七项结构与底图](stages/13-design/references/gen-prompt-scope.md)，阶段只注入相关段落。
- 页面设计：[封面](stages/13-design/references/title-page.md)、[目录](stages/13-design/references/toc-page.md)、[内容页](stages/13-design/references/content-page.md)、[版式意图](stages/13-design/references/layout-intent.md)、[几何词汇](stages/13-design/references/layout-splits.md)。
- 内部设计与检查：[设计原则](shared/design-principles.md)、[内容与文字](shared/content-density-and-text-color.md)、[预览与贴回](shared/preview-contract.md)、[阶段与素材](shared/artifact-contract.md)、[返回编辑与复用](shared/incremental-rework.md)。

参考PPT图片已移除，保留文字归纳、历史来源元数据与几何示意；它们不作为新项目材料或事实。未使用的原始阶段入口、schema、命令模板和旧操作说明已移除；同步采用白名单，避免旧口径再次进入Agent。

manifest.json登记文件哈希与版本；更新后需重新计算。同步原工作流库时保留本项目维护的当前指南，防止旧规则重新覆盖。
