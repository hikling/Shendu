---
version: alpha
name: "慎独"
description: "以日期为锚点、适合安静书写的自托管复盘界面"
colors:
  background: "#eef4f3"
  writing: "#fbfcfa"
  ink: "#1b3133"
  muted: "#52646a"
  line: "#c9d8d7"
  primary-default: "#176b67"
typography:
  writing:
    fontFamily: "Noto Serif SC, Songti SC, STSong, Source Han Serif SC, serif"
  interface:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
  numeric:
    fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace"
rounded:
  panel: "22px"
  control: "14px"
  pill: "999px"
spacing:
  mobile-gutter: "16px"
  panel-padding: "24px"
  content-max: "860px"
components:
  button: { owner: "shendu/public/styles.css .btn" }
  card: { owner: "shendu/public/styles.css .card" }
  dialog: { owner: "shendu/public/app.js openModal" }
  review-navigation: { owner: "shendu/public/app.js renderReview" }
---

# 慎独设计系统

## 方向与使用场景

慎独服务于自己记录与回看复盘的人，以中文、个人私密、桌面与手机书写为主要场景。首要工作是看清今天的状态，开始或继续写。主视觉来自真实日期与纸面留白，像清晨窗边的一页笔记。避免高饱和统计卡、发光边框、多层玻璃、无意义花体编号和把四个长表单同时摊开的布局。

产品界面保持安静；登录页可以保有原有品牌表达。日期作为每日页唯一强调的视觉记忆点。其他路由沿用同一导航、状态与操作语言，业务内容逐步迁移。

## 颜色与主题

上方 frontmatter 给出默认浅色设计目标；运行时 CSS 变量是实际唯一实现来源。`shendu/public/styles.css` 定义背景、书写表面、文本、边界及玻璃变量；`shendu/public/app.js` 的 `applyTheme()` 继续设置 `--primary`、`--secondary`、`--tertiary` 和文字对比色。文档与运行时变量在同一改动中核对。六套预设和自定义色只改变语义强调色，不使玻璃透明度或正文对比随意漂移。

玻璃只用于每日首屏与辅助面板；表单、长文和密集信息使用接近不透明的书写底色。不支持 `backdrop-filter` 时使用不透明表面。状态不能仅靠颜色表示。

## 字体与布局

中文复盘标题及长文保留宋体气质，导航、按钮、状态和帮助文字使用系统无衬线；日期数字清晰，避免花体。一级标题、区标题、字段标签和正文形成四级清楚层次。正文行长与行距适合持续输入。

桌面常驻侧边导航，主内容最大约 860px；辅助信息按需覆盖。820px 以下导航使用抽屉，手机内容边距约 16px，书写区自然随文档滚动。界面不因状态文字或字体加载移动主要按钮。

## 深度、形状与组件

面板以色块、细边和少量短阴影分层。圆角沿用产品已有的柔和形状，主面板约 22px，输入与控件约 14px。不要靠更多阴影表达更多层级。主按钮承接主题色，次按钮用中性描边；危险的永久锁定在最终确认中提高强调度。禁用、忙碌、错误、成功、只读和选中态均有文本或形状提示；交互目标有明确 hover、focus-visible 和按下反馈。

所有导航用语、保存状态、离开提醒、完成确认、错误提示沿用现有共享 `app.js` 通道。表单输入的可读性优先于透光。辅助面板是可访问的按需区域，Escape 关闭并恢复焦点。滚动条保持可见。用户或系统减少动态效果时取消非必要动画。

## 内容规则

用“开始今日复盘”“继续今日复盘”“保存草稿”“完成并锁定”等具体动作。四区状态只说“待填写/已填写”，避免暗示通过校验。帮助文字解释下一步，不写空泛的激励句。统计留作次要信息，不在每日首屏与主动作竞争。
