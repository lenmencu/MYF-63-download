# MYF-63-download

明裕丰星闪模组在线烧录与串口工具。支持 WS63（MYF-F63）与 BS2X（MYF-F20 / F21）。

## 网页烧录

Chrome / Edge 打开后，可本地选择 `.fwpkg`，经 Web Serial 烧录，并带串口监视器。

```bash
npm install
npm run dev
```

浏览器访问本地地址。固件只在本机解析，不会上传服务器。

## 命令行 histool

```bash
pip install -e download/
histool -p /dev/ttyACM0 flash path/to/xxx.fwpkg
histool -p /dev/ttyACM0 monitor
```

详见 `download/README.md`。
