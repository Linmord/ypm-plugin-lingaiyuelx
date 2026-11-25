// Package server 是控制台的 HTTP 层：16 个 API 路由 + 前端静态页。
//
// 插件逻辑不在这里，而是在 QuickJS 里跑（见 internal/jsrt）。
// 这一层只负责把 HTTP 请求翻译成对 JS 模块的调用。
package server

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"runtime/debug"
	"strings"
	"time"
)

// Runtime 是控制台需要的那部分插件能力，由 jsrt 实现。
type Runtime interface {
	// Account 返回某音源的账号快照
	Account(provider string) (map[string]any, error)
	// SignIn 启动扫码登录，返回后由插件异步推进
	SignIn(provider string) error
	SignOut(provider string) error
	SignInByCookie(uin, musickey, loginType string) (map[string]any, error)
	// Accounts 列出某音源已保存的账号
	Accounts(provider string) ([]map[string]any, error)
	SwitchAccount(id string) ([]map[string]any, error)
	RemoveAccount(id string) ([]map[string]any, error)
	// Sources 管理洛雪音源
	ListSources() ([]map[string]any, error)
	ImportSource(name, source string) (map[string]any, error)
	ImportSourceFromURL(name, url string) (map[string]any, error)
	ReorderSources(names []string) ([]map[string]any, error)
	RemoveSource(name string) ([]map[string]any, error)
	// Capabilities 探测运行环境
	Capabilities() (map[string]any, error)
	// Close 释放 JS 运行时
	Close()
}

// Settings 是读写 settings.json 的抽象。
type Settings interface {
	Read() map[string]string
	Write(next map[string]string) error
}

// Options 是启动控制台需要的依赖。
type Options struct {
	Runtime   Runtime
	Settings  Settings
	IndexHTML []byte
	Log       func(string)
	Version   string
}

// Providers 是支持的两个音源。
var Providers = []string{"netease", "qq"}

// loginState 记录每个音源的扫码状态，前端轮询 /api/prompt 拿。
type loginState struct {
	Status  string `json:"status"`
	Message string `json:"message"`
}

// prompt 是推给前端的二维码。
type prompt struct {
	QR   string `json:"qr"`
	Text string `json:"text"`
}

// Server 持有运行时状态。
type Server struct {
	opt     Options
	prompts map[string]*prompt
	states  map[string]loginState
	active  string
}

// New 创建控制台。
func New(opt Options) *Server {
	if opt.Log == nil {
		opt.Log = func(string) {}
	}
	s := &Server{
		opt:     opt,
		prompts: map[string]*prompt{},
		states:  map[string]loginState{},
	}
	for _, name := range Providers {
		s.states[name] = loginState{Status: "idle", Message: ""}
	}
	return s
}

// SetPrompt 供 JS 侧的 host.signInPrompt 回调调用。
func (s *Server) SetPrompt(provider, qr, text string) {
	if qr == "" && text == "" {
		return
	}
	if provider == "" {
		provider = s.active
	}
	if qr != "" {
		s.prompts[provider] = &prompt{QR: qr, Text: text}
	}
	if text != "" {
		st := s.states[provider]
		st.Message = text
		s.states[provider] = st
	}
}

// SetLoginStatus 供 JS 侧登录完成时调用。
func (s *Server) SetLoginStatus(provider, status, message string) {
	s.states[provider] = loginState{Status: status, Message: message}
	if status != "pending" {
		delete(s.prompts, provider)
	}
	if status != "pending" && s.active == provider {
		s.active = ""
	}
}

// Handler 返回配置好的路由。
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.handleIndex)

	mux.HandleFunc("/api/status", s.handleStatus)
	mux.HandleFunc("/api/settings", s.handleSettings)
	mux.HandleFunc("/api/login", s.handleLogin)
	mux.HandleFunc("/api/logout", s.handleLogout)
	mux.HandleFunc("/api/loginCookie", s.handleLoginCookie)
	mux.HandleFunc("/api/capabilities", s.handleCapabilities)
	mux.HandleFunc("/api/sources/luoxue", s.handleSourcesList)
	mux.HandleFunc("/api/sources/import", s.handleSourcesImport)
	mux.HandleFunc("/api/sources/importUrl", s.handleSourcesImportURL)
	mux.HandleFunc("/api/sources/reorder", s.handleSourcesReorder)
	mux.HandleFunc("/api/sources/remove", s.handleSourcesRemove)
	mux.HandleFunc("/api/accounts", s.handleAccounts)
	mux.HandleFunc("/api/accounts/switch", s.handleAccountsSwitch)
	mux.HandleFunc("/api/accounts/remove", s.handleAccountsRemove)
	mux.HandleFunc("/api/activeProvider", s.handleActiveProvider)
	mux.HandleFunc("/api/loginMode", s.handleLoginMode)
	mux.HandleFunc("/api/prompt", s.handlePrompt)
	mux.HandleFunc("/api/cancel", s.handleCancel)

	return withCORS(withRecover(mux, s.opt.Log))
}

// withRecover 兜住 handler 里的 panic，避免连接被直接掐断。
// 没有这层的话，插件 JS 抛异常时前端只会看到「连接被意外关闭」。
func withRecover(next http.Handler, log func(string)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				if log != nil {
					log(fmt.Sprintf("panic %s: %v\n%s", r.URL.Path, rec, string(debug.Stack())))
				}
				writeJSON(w, http.StatusInternalServerError, map[string]any{"error": fmt.Sprint(rec)})
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// Listen 在 127.0.0.1:port 上启动，返回实际监听地址。
func (s *Server) Listen(port int) (*http.Server, string, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:"+itoa(port))
	if err != nil {
		return nil, "", err
	}
	srv := &http.Server{
		Handler:           s.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go srv.Serve(ln)
	return srv, ln.Addr().String(), nil
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func readJSON(r *http.Request, dst any) error {
	defer r.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
	if err != nil {
		return err
	}
	if len(strings.TrimSpace(string(raw))) == 0 {
		return nil
	}
	return json.Unmarshal(raw, dst)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var buf [12]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
