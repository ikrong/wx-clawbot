# 微信个人号助手

基于 @tencent-weixin/openclaw-weixin 项目，剔除了openclaw相关依赖，专注微信个人助手的消息接收和回复。

# 安装

```shell
npm install wx-clawbot
```

# 使用

```javascript
import { WechatBot } from "wx-clawbot";
import qr from "qrcode-terminal"; // 安装一个终端二维码生成工具

new WechatBot()
    .ensureLogin()
    .on("scan", ({ url }) => {
        qr.generate(url, { small: true }, (qrcode) => {
            console.log("请使用微信扫码登录");
            console.log(qrcode);
        });
    })
    .on("message", (message) => {
        // 处理消息
        message.text; // 文本消息
        message.downloadMedia(); // 下载媒体，返回的是buffer，需要自己处理文件

        // 回复消息
        message.sendText("hello");
        message.sendImage("./image.png");
        message.sendFile("./file.pdf");
        message.sendVideo("./video.mp4");
    });
```

# WechatBot 支持的事件

- login: 登录结果，参数：{ status: 'success' | 'failed' }
- logout: session过期
- scan: 扫码登录, 参数：{ url: string }
- scaned: 扫码成功
- connected: 连接成功
- message: 收到消息, 参数：Message
- error: 错误，参数：Error

# 许可证

MIT License
