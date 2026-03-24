# 微信个人号助手

基于 @tencent-weixin/openclaw-weixin 项目，剔除了openclaw相关依赖，专注微信个人助手的消息接收和回复。

# 安装

```shell
npm install wx-clawbot
```

# 使用

```javascript
import { WechatBot } from "wx-clawbot";

new WechatBot().ensureLogin().then((bot) => {
    bot.on("message", (message) => {
        // 处理消息
        message.text; // 文本消息
        message.downloadMedia(); // 下载媒体，返回的是buffer，需要自己处理文件

        // 回复消息
        message.sendText("hello");
        message.sendImage("./image.png");
        message.sendFile("./file.pdf");
        message.sendVideo("./video.mp4");
    });
});
```

# 许可证

MIT License
