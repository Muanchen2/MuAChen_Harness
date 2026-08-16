# Agent Note: 纯文本模型的图片消息降级为文件引用

Status: implemented

[English](2026-08-16-image-degrade-text-only.md) | 中文

纯文本模型无法接收图片内容,因此携带图片的网页端 prompt 在 api-proxy 准入步骤被以 `MODEL_DOES_NOT_SUPPORT_IMAGES` 拒绝。这挡住了合理的工作流:用户想粘贴截图,让纯文本模型通过 `vision-describe` skill 读取。

准入步骤现在改为降级而非拒绝。当所选模型的 `inputModalities` 不含 `image` 时,每个图片 part 被解码写入 `<cwd>/.dsh-uploads/` 下的本地文件(会话没有 workspace cwd 时写入系统临时目录),持久化的用户消息携带文本引用:绝对路径、字节数、媒体类型。模型用文件系统工具读取该文件,并通过视觉 skill 描述。多模态模型保持原有图片路径,不受影响。

降级路径上既有限制仍然生效:写文件前先执行单条消息的图片数量与总字节检查。

相关 note:[atomic-web-image-admission](../bug-fix/2026-07-29-atomic-web-image-admission.md)
保持准入串行化不变;本改动只替换了拒绝分支。部分取代
[pi-ai-route-default-input-modalities](../architecture/2026-08-12-pi-ai-route-default-input-modalities.md)
中"prompt 准入拒绝图片"的表述(模态解析链未变),以及
[minimal-read-image-tool](../feature/2026-08-10-minimal-read-image-tool.md)
中"文本路由拒绝而非降级"的缺口:委托查看的故事现在存在于 api-proxy 层,
`read_image` 工具的路由门禁本身保持该 note 记录的原样。

覆盖: `api-proxy-models.spec.ts` 新增纯文本降级用例,断言 prompt 被接受、写入文件字节正确、落在临时目录,以及两个限制拒绝(`TOO_MANY_IMAGES`、`IMAGES_TOO_LARGE`)。
