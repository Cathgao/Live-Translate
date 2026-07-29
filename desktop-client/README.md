# Live Translate — 桌面客户端（Tauri 2）

实时语音翻译的桌面客户端。**无边框 + 不透明窗口**，使用 WebView2 作为渲染层，连接用户在「设置」面板中填写的 WebSocket 端点，并内置 **UART 串口**把译文流式推送给外部 MCU / 串口屏。

整个 `desktop-client/` 目录是**自包含**的：放到任何装了前置依赖的 Windows 机器上，`npm install && npm run tauri:dev` 就能跑；首次启动会在设置弹窗里让你填服务端地址，之后会自动保存。

---

## 功能

- **无边框 + 不透明**窗口（`decorations: false`），无 Windows 标题栏；顶部条是拖拽区，里面放了窗口控制按钮（设置、最小化、最大化/还原、关闭）。
- 默认**最大化**启动（`tauri.conf.json` 里 `maximized: true`）。
- 双面板转写 UI：上半原文 / 下半译文，流式累积 + 提交分段。
- 底部只有一个圆形麦克风按钮（蓝色待机 → 红色录音）+ 状态徽章（`麦克风已关闭` / `麦克风已激活`）+ 音量条 + Token 计数。
- **UART 串口**：
  - 列出所有可用 COM 口（含 USB / Bluetooth / PCI 标签）。
  - 可配置波特率、数据位、校验、停止位、换行字符、发送帧格式（`ORIG:/TRANS: 多行` 或 `JSON 单行`）。
  - 每次有新的转写就往打开的串口推送 `ORIG:...` / `TRANS:...` 行。
  - 预留 RX 命令：`PING` → 自动回 `PONG`；`TOGGLE_RECORD` → 仅记录日志（未来版本再接到 UI）。
  - 折叠面板显示最近的 RX 字节。
- 所有通用设置（语言、VAD、字号、串口配置、Token 用量）持久化到 `localStorage`；**WebSocket 地址**单独存到 OS 应用数据目录下的 `settings.json`，**不会**编译进二进制里。

## 目录结构

```
desktop-client/
├── README.md
├── package.json / package-lock.json
├── vite.config.ts
├── tsconfig.json
├── index.html
├── .gitignore
├── public/pcm-worklet.js            # 音频采集 worklet（从 frontend/ 复制）
├── scripts/run-tauri.mjs            # 用 node 启动 tauri，自动把 cargo 加到 PATH
├── src/                             # React 前端
│   ├── main.tsx
│   ├── App.tsx                      # 双面板 UI + 设置弹窗 + 串口面板
│   ├── audio.ts                     # AudioRecorderManager + TranslationAudioPlayer
│   ├── ws.ts                        # LiveClient（WS 消息分发，URL 由调用方传入）
│   ├── serial.ts                    # Tauri 命令包装 + 事件监听
│   ├── settings.ts                  # 设置 + Token 用量持久化（localStorage）
│   ├── configStore.ts               # WebSocket URL 持久化（Tauri command 包装 + 校验）
│   └── index.css                    # Tailwind v4 + drag-region CSS
└── src-tauri/                       # Rust 后端
    ├── Cargo.toml / Cargo.lock
    ├── tauri.conf.json              # 窗口：decorations:false, transparent:false, maximized:true
    ├── build.rs
    ├── capabilities/default.json    # Tauri 2 ACL（窗口控制 + 串口命令权限）
    ├── icons/icon.ico
    └── src/
        ├── main.rs
        ├── lib.rs                   # 6 个 Tauri 命令：serial_* + get_config / save_config
        ├── serial_mgr.rs            # SerialManager + 每端口一个 RX 线程
        └── config.rs                # get_config / save_config（写 OS 应用数据目录）
```

## 前置依赖（Windows）

| 工具 | 用途 | 安装 |
|---|---|---|
| **Node.js ≥ 18** | Vite dev server + npm 脚本 | <https://nodejs.org/> |
| **Rust (stable)** | 编译 Tauri | <https://rustup.rs/>（或 `winget install Rustlang.Rustup`） |
| **MSVC Build Tools / VS 勾选 C++ 工作负载** | 提供 `link.exe` + Windows SDK | Visual Studio Installer →「使用 C++ 的桌面开发」 |
| **WebView2 Runtime** | Tauri 在 Windows 上的渲染引擎 | Win 11 自带；Win 10 由 Tauri 首次运行时自动引导安装 |

Rust 编译时通过 `vswhere.exe` 自动发现 MSVC，**不依赖任何特定安装路径**，所以 VS 装在 C 盘、D 盘还是别的盘都无所谓。

## 安装与运行

```bash
cd desktop-client
npm install
npm run tauri:dev
```

- 首次 Rust 构建需要 3-10 分钟（下载并编译所有 Tauri 依赖）。
- 之后的增量编译是秒级。
- 应用启动后会开一个最大化无边框窗口。如果尚未配置服务端地址，会自动弹出设置弹窗让你填写。

### WebSocket 地址配置

服务端地址**不在编译期硬编码**，而是首次启动时通过设置弹窗填写，并写入：

| OS | 路径 |
|---|---|
| Windows | `%LOCALAPPDATA%\com.example.live-translate-desktop\settings.json` |
| macOS | `~/Library/Application Support/com.example.live-translate-desktop/settings.json` |
| Linux | `~/.local/share/com.example.live-translate-desktop/settings.json` |

文件示例：

```json
{
  "ws_url": "wss://fanyi.example:443/live"
}
```

填好后保存即生效；修改后再保存会立即写入磁盘。WebView2 内部存的其他设置（语言、VAD、串口参数等）不会被影响。

## 打 release 安装包（`.msi` / `.exe`）

```bash
npm run tauri:build
```

产物在 `src-tauri/target/release/bundle/{msi,nsis}/`。安装包是**自包含**的，目标机器不需要装 Node / Rust / VS（WebView2 自动检测 / 自动安装）。

## WebSocket 协议

与网页端、以及 `client-example/` Node 参考客户端**完全一致**。完整规范见 `client-example/README.md` §3。

连接地址由「设置 → WebSocket 地址」决定，启动时拼上查询参数：

```
<wsUrl>?source=Auto&target=Chinese%20(Simplified)&silenceMs=1000[&token=...]
```

`token` 查询参数**仅在**服务端 `CLIENT_AUTH_TOKEN` 环境变量被设置时才需要（公开服务器未设置，所以一般不需要）。

## UART 帧格式

打开 COM 口后，每次转写增量都会按配置的帧格式写到串口：

**`prefix-multi`**（默认，大多数 MCU 屏幕可直接读）：
```
ORIG:Hello world\r\n
TRANS:你好世界\r\n
```

**`json-single`**（每行一条 JSON）：
```
{"o":"Hello world","t":"你好世界"}\r\n
```

此外，在 `transcription_finished` 时再发一个换行（按 `lineEnding` 配置），方便屏幕推一行。

## 已知限制

- WS 断开后不自动重连（重新点麦克风按钮即可）。
- 同时只能打开一个 COM 口。
- `TOGGLE_RECORD` 等未来 MCU 控制命令当前仅打印日志，UI 不响应。
- `serialport` crate 跨 Windows / macOS / Linux，但编译与权限流程只在 Windows 上验证过。

## 故障排查

| 现象 | 处理 |
|---|---|
| `cargo metadata` 报 "program not found" | rustup 安装后 PATH 没刷新。重新登录，或直接用 `scripts/run-tauri.mjs`（它会自动把 `~/.cargo/bin` 加到 PATH）。 |
| `link.exe` 找不到 | 安装 MSVC：VS Installer →「使用 C++ 的桌面开发」。`cargo build` 能验证。 |
| 麦克风权限被拒 | 系统设置 → 隐私与安全 → 麦克风 → 允许桌面应用访问。 |
| COM 口打不开 | 检查设备管理器是否有 `!`；确认端口没被其他程序占用。 |
| TX 帧收不到 | 确认波特率 / 数据位 / 停止位跟 MCU 的 `Serial.begin(...)` 一致。可以在客户端点 `PING` 测试 — MCU 应在 1 秒内回 `PONG`。 |
| 中文显示成方块 | 安装中文字体（Microsoft YaHei / PingFang 等）。 |