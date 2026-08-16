# Agent Note: image prompts degrade to file references for text-only models

Status: implemented

English | [中文](2026-08-16-image-degrade-text-only.zh.md)

Text-only models cannot receive image content, so a web prompt carrying an
image was refused at the api-proxy admission step with
`MODEL_DOES_NOT_SUPPORT_IMAGES`. That blocked a legitimate workflow: the user
wants to paste a screenshot and have the text-only model read it through the
`vision-describe` skill.

The admission step now degrades instead of refusing. When the selected model's
`inputModalities` exclude `image`, each image part is decoded and written to a
local file under `<cwd>/.dsh-uploads/` (or the OS temp dir when the session has
no workspace cwd), and the durable user message carries a text reference with
the absolute path, byte count, and media type. The model reads the file with
its filesystem tool and describes it through the vision skill. Multi-modal
models keep the existing image path untouched.

Existing limits still apply on the degradation path: the per-message image
count and aggregate byte checks run before any file is written.

Related notes: [atomic-web-image-admission](../bug-fix/2026-07-29-atomic-web-image-admission.md)
keeps the admission ordering; this change only swaps the refusal branch.
Partially supersedes
[pi-ai-route-default-input-modalities](../architecture/2026-08-12-pi-ai-route-default-input-modalities.md)'s
"prompt admission refuses an image" reading (the modality resolution chain is
unchanged) and
[minimal-read-image-tool](../feature/2026-08-10-minimal-read-image-tool.md)'s
"text route refuses instead of degrading" gap: the delegated-viewing story now
exists at the api-proxy layer, while the `read_image` route gate itself stays
as recorded there.

Coverage: `api-proxy-models.spec.ts` gained a text-only degradation case
asserting the accepted prompt, the written file bytes, the temp-dir location,
and both limit rejections (`TOO_MANY_IMAGES`, `IMAGES_TOO_LARGE`).
