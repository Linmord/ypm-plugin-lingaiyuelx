// 小林的音源扩展 · 本地管理控制台
//
// 单文件可执行程序：内置 QuickJS 跑插件自己的登录/音源逻辑，
// 用户不需要装 Node 或任何运行时。
package main

import (
	"context"
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"ypm-console/internal/jsrt"
	"ypm-console/internal/server"
)

//go:embed web/index.html
var webFS embed.FS

// 版本号由 -ldflags 注入，缺省 dev。
var version = "dev"

func main() {
	port := flag.Int("port", 47800, "监听端口")
	pluginDir := flag.String("plugin", "", "插件目录（缺省按 APPDATA 推断）")
	dataDir := flag.String("data", "", "插件数据目录（缺省按 APPDATA 推断）")
	open := flag.Bool("open", true, "启动后自动打开浏览器")
	flag.Parse()

	if err := run(*port, *pluginDir, *dataDir, *open); err != nil {
		fmt.Fprintln(os.Stderr, "启动失败:", err)
		os.Exit(1)
	}
}

func run(port int, pluginDir, dataDir string, openBrowser bool) error {
	root, err := defaultRoot()
	if err != nil {
		return err
	}
	if pluginDir == "" {
		pluginDir = filepath.Join(root, "YesPlayMusic", "plugins", "multisource")
	}
	if dataDir == "" {
		dataDir = filepath.Join(root, "YesPlayMusic", "plugin-data", "multisource")
	}
	if _, err := os.Stat(filepath.Join(pluginDir, "plugin.json")); err != nil {
		return fmt.Errorf("找不到插件目录 %s，用 -plugin 指定", pluginDir)
	}
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return fmt.Errorf("建数据目录: %w", err)
	}

	settings := &fileSettings{path: filepath.Join(dataDir, "settings.json")}
	logPath := filepath.Join(os.TempDir(), "ypm-console-debug.log")
	_ = os.Remove(logPath)
	logf := func(msg string) {
		line := fmt.Sprintf("%s %s\n", time.Now().Format("15:04:05"), msg)
		fmt.Print(line)
		if f, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644); err == nil {
			f.WriteString(line)
			f.Close()
		}
	}
	logf("插件目录: " + pluginDir)
	logf("数据目录: " + dataDir)

	// 先建 server 占位，runtime 的回调要写进它
	var srv *server.Server
	logf("正在初始化 QuickJS…")
	rt, err := jsrt.New(pluginDir, dataDir, jsrt.Hooks{
		GetSettings: func() map[string]string { return settings.Read() },
		OnLog:       logf,
		OnPrompt: func(provider, qr, text string) {
			if srv != nil {
				srv.SetPrompt(provider, qr, text)
			}
		},
		OnStatus: func(provider, status, message string) {
			if srv != nil {
				srv.SetLoginStatus(provider, status, message)
			}
			logf(provider + " 登录状态: " + status + " " + message)
		},
	})
	if err != nil {
		return err
	}
	defer rt.Close()
	logf("QuickJS 就绪")

	html, err := webFS.ReadFile("web/index.html")
	if err != nil {
		return fmt.Errorf("读取内置页面: %w", err)
	}

	srv = server.New(server.Options{
		Runtime:   rt,
		Settings:  settings,
		IndexHTML: html,
		Log:       logf,
		Version:   version,
	})

	httpSrv, addr, err := srv.Listen(port)
	if err != nil {
		return fmt.Errorf("监听 127.0.0.1:%d: %w", port, err)
	}
	url := "http://" + addr
	logf("控制台已启动: " + url)
	logf("插件目录: " + pluginDir)
	logf("数据目录: " + dataDir)

	if openBrowser {
		if err := openURL(url); err != nil {
			logf("打不开浏览器，请手动访问 " + url)
		}
	}

	// 等 Ctrl+C
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	logf("正在退出…")

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(ctx)
	_ = rt.Store().Flush()
	return nil
}

// defaultRoot 返回 %APPDATA%。
func defaultRoot() (string, error) {
	if v := os.Getenv("APPDATA"); v != "" {
		return v, nil
	}
	return "", fmt.Errorf("读不到 APPDATA，请用 -plugin 和 -data 指定路径")
}

// fileSettings 是 settings.json 的读写实现。
type fileSettings struct{ path string }

func (f *fileSettings) Read() map[string]string {
	out := map[string]string{}
	raw, err := os.ReadFile(f.path)
	if err != nil {
		return out
	}
	var any map[string]any
	if err := json.Unmarshal(raw, &any); err != nil {
		return out
	}
	for k, v := range any {
		if s, ok := v.(string); ok {
			out[k] = s
		} else {
			out[k] = fmt.Sprint(v)
		}
	}
	return out
}

func (f *fileSettings) Write(next map[string]string) error {
	if err := os.MkdirAll(filepath.Dir(f.path), 0o755); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(next, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(f.path, append(raw, '\n'), 0o644)
}
