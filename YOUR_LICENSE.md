# YOUR_LICENSE.md — 本仓库的原创贡献授权声明

本文件只是声明文件，不改写上游任何包的 package.json `license` 字段，也不改变
`LICENSE` 对上游 DeepSeek 代码的 MIT 授权。

## 双重授权结构

本仓库是 DeepSeek Harness（`deepseek-harness`，MIT）的 fork，并在此基础上持续加入了
你（Muanchen2 / 沐安宸 / 凛）自己的原创代码。因此**在作者不同、授权亦不同的前提下**，
本仓库存在两种授权：

| 范围 | 版权归属 | 授权 |
|---|---|---|
| 上游 DeepSeek Harness 的原始代码与文档 | © 2026 DeepSeek | **MIT**（见 `LICENSE`，保持原样） |
| 你新增的原创代码与文档（如 `packages/memory/`，含 `dsh-memory` / `dsh-tool-memory` 及其后续演进） | © 2026 Muanchen2 | **GPL-3.0**（本文件） |

## 你原创的贡献按 GPL-3.0 授权

凡是你（Muanchen2 / 沐安宸 / 凛）在本 fork 上**新写**的、不直接复制自上游的源码、
配置、文档、脚本及其衍生（典型如 `packages/memory/` 下的 Rin 记忆服务），如果你的
仓库级 `package.json` / `LICENSE` 声明默认其为开源，则这些原创部分按 **GNU General
Public License v3.0（GPL-3.0）** 授权。GPL-3.0 的完整文本见：
https://www.gnu.org/licenses/gpl-3.0.html

选择 GPL-3.0 的意图：确保任何基于这些原创贡献制作的作品，若对外分发，必须以
GPL-3.0 兼容的方式释放其对应源码 —— 防止你的原创部分被闭源地、私下地商用而不回馈。

## 边界与可执行性说明

- 本声明**不**为 DeepSeek 的原始 MIT 代码主张 GPL 权利。上游部分始终受其原作者的
  MIT 授权约束，你不能单方面更改其协议；只要保留 LICENSE 中上游的 MIT 声明，就满足
  MIT 的可再分发条件。
- 若你后续决定把某个包的 SPDX 字段从缺省改为显式 `GPL-3.0`，仍须遵守仓库门禁
  （`verify-dsh-package-licenses` 强制 `@deepseek-ai/dsh-*` 为 MIT），届时需为该包
  单独豁免或移除该门禁对它的约束。
- 本文件不是法律意见。涉及对外授权、分发或商业化的具体决策，建议咨询持牌法律专业人士。
