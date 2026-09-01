# MYF-63-download

明裕丰星闪模组在线烧录与串口工具。支持 WS63，以及 BS2X 系列的 BS20、BS21、BS21E。

## 网页烧录

Chrome / Edge 打开后，可本地选择完整 `.fwpkg`，经 Web Serial 烧录，并带串口监视器。芯片型号由开发者手动选择；固件会在本地校验分区、地址族、地址范围与 CRC，不会上传服务器。

- WS63：2,000,000 baud，开始烧录后手动按一次复位键。
- BS20 / BS21 / BS21E：500,000 baud，开始烧录后手动按一次复位键；CH342 请选择 SERIAL-A，不要选择 SERIAL-B。
- 完成条件：全部分区传输确认、复位成功，并在 115200 baud 检测到启动日志。

```bash
npm install
npm run dev
```

需要 Node.js `^20.19.0` 或 `>=22.12.0`。浏览器访问本地地址后，按页面提示授权串口。

## 验证

```bash
npm test
npm run lint
npm run build
```

## 命令行 histool

```bash
pip install -e download/
histool -p /dev/ttyACM0 flash path/to/xxx.fwpkg
histool -p /dev/ttyACM0 monitor
```

详见 `download/README.md`。
