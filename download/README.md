# histool

HiSilicon WS63 / BS2X 串口烧录与日志工具，用法对齐 [esptool](https://github.com/espressif/esptool#commands)。协议与 `burn`（`xf_burn_tools`）相同：ROM 握手 → Ymodem 下装 loaderboot → 写 Flash → 复位。

## 安装（全局可用）

```bash
# 开发模式：改代码立即生效，命令名 histool
pip install -e download/

# 或普通安装到当前 Python 环境
pip install download/
```

装好后任意目录可直接：

```bash
histool -p /dev/ttyACM0 flash path/to/xxx.fwpkg
histool -p /dev/ttyACM0 monitor
```

若提示找不到命令，把 `python3 -m site --user-base`/bin 加到 `PATH`（常见于 `pip install --user`）。

未安装时仍可本地运行：

```bash
python3 download/histool.py -p /dev/ttyACM0 flash xxx.fwpkg
# 或
PYTHONPATH=download python3 -m hisboot -p /dev/ttyACM0 flash xxx.fwpkg
```

## 依赖

`pip install -e download/` 会自动安装 `pyserial`；也可单独：

```bash
pip install -r download/requirements.txt
```

## 芯片与默认波特率 / 流控

根据固件路径自动识别（`-c auto`，默认）：

| 路径示例 | 芯片 | 默认波特率 | 默认流控 |
| --- | --- | --- | --- |
| `output/ws63/fwpkg/.../ws63-liteos-app_all.fwpkg` | ws63 | **1000000** | none |
| `output/bs20/fwpkg/standard-bs20-n1200/bs20_all_in_one.fwpkg` | bs20 | **500000** | none |
| `output/bs21e/fwpkg/standard-bs21e-1100/bs20_all_in_one.fwpkg` | bs21e | **500000** | none |

流控对齐 burn：

- 握手 uart_param 末字节 `flow_ctrl=0`
- 主机串口 `rtscts=False`（烧录过程中由工具主动占用 RTS）
- 复位：RTS **拉低 → 拉高**，握手等 2s；未进下载模式则再复位；成功后立刻切波特率并烧录
- 烧录结束 hard-reset：协议复位 + 同样的 RTS 拉低/拉高

可用波特率对齐 burn `AVAIL_BAUD`：115200…2000000。可用 `-b` / `-c` 覆盖；仅在接好 CTS 时再用 `--flow rtscts`（启用后主机不再独占 RTS，自动复位可能失效）。

## 常用命令

```bash
# ws63（自动 1M，无硬件流控）
python3 download/histool.py -p /dev/ttyACM0 flash \
  output/ws63/fwpkg/ws63-liteos-app/ws63-liteos-app_all.fwpkg

# bs20 / bs21e（自动 500000）
python3 download/histool.py -p /dev/ttyACM0 flash \
  output/bs20/fwpkg/standard-bs20-n1200/bs20_all_in_one.fwpkg
python3 download/histool.py -p /dev/ttyACM0 flash \
  output/bs21e/fwpkg/standard-bs21e-1100/bs20_all_in_one.fwpkg

# 手动指定波特率 / 流控
python3 download/histool.py -p /dev/ttyACM0 -c ws63 -b 1000000 flash xxx.fwpkg
python3 download/histool.py -p /dev/ttyACM0 --flow rtscts flash xxx.fwpkg

# 烧录后看日志
python3 download/histool.py -p /dev/ttyACM0 flash xxx.fwpkg --after monitor
python3 download/histool.py -p /dev/ttyACM0 monitor
```

握手阶段固定 **115200**。日志退出：`Ctrl+]` / `Ctrl+C`。
