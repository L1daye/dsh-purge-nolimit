# 商业授权与联系

正本在 [LICENSE](./LICENSE)。这里只说怎么谈。

## 免费使用（无需联系）

- **个人本机自用**：不另外收费，遵守 Apache-2.0 即可。
- **内部评测、科研、教学**：同上，不需要授权。
- **二次开发并开源**：可以，但**必须署名**，见下节。

## 需要商业授权

- 拿去**卖**、**卖课**、**白标**、**给第三方当产品**；
- 打包进你的**商业产品**分发；
- 对外提供**托管服务**（SaaS）。

这些情况先写信谈。

## 联系方式

**邮件**：[lidayet94@gmail.com](mailto:lidayet94@gmail.com)
**GitHub**：[@L1daye](https://github.com/L1daye)

标题写：`dsh-purge-nolimit 商业许可`。

正文写清三件事：**用途**、**是否再分发**、**大致规模**。

没有自动收银台，谈妥再签。

## 授权范围（重要）

**本页授权的对象是本仓库 `dsh-purge-nolimit` 的代码与文档。**

上游情况：

| 上游 | 许可 | 说明 |
| --- | --- | --- |
| [YuJunZhiXue/dsh-purge](https://github.com/YuJunZhiXue/dsh-purge) | Apache-2.0 | 原始架构、补丁引擎、提示词体系。原作者另有商业渠道，**本页不代理、不代表、也不转让其权益**。 |
| [kingcharleslzy-ai/dsh-purge](https://github.com/kingcharleslzy-ai/dsh-purge) | MIT | 社区版，本仓库借用了 refusal-retry、atomic-files、probe 等模块。MIT 允许商业使用，保留其版权声明即可。 |

本仓库**自己新增**的部分——全量解除改造、`refusal-retry`、注入探针、原子写硬化、观测层（verify / preflight / trace）、`armor-scorer` 重写、DSH 0.2.2 适配与 160+ 单元测试——归本仓库维护者，按本页条款授权。

**如果你要的是“原版 dsh-purge”的商业授权，请直接联系原作者。**

## 署名要求（不可转让）

无论是否购买商业授权：

- **必须保留** [NOTICE](./NOTICE) 与其中的三条上游来源链接；
- **必须保留** README 开头的「二次开发声明」；
- **不得**对外自称官方，或暗示获得 DeepSeek 官方背书；
- **不得**把本仓库的名字改成另一个名字后当作原创发布。

原作者的要求同样适用：**原版不允许倒卖**。卖 fork 可以，卖“原版”不行。

## 历史说明

上游在 MIT 时期发布的 tag 无法追改。本仓库从 Apache-2.0 版本（1.1.82 之后）分叉，遵循 Apache-2.0。
