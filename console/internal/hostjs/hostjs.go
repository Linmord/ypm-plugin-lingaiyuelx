// Package hostjs 在 QuickJS 里搭出 YesPlayMusic 的 host 全局对象。
//
// 控制台要复用插件自己的登录/加密/取址逻辑，就必须让插件的 JS 代码
// 以为自己在宿主里跑：host.storage 能读写、host.crypto 能算签名、
// fetch 能发请求、host.signInPrompt 能把二维码推给前端。
package hostjs

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/buke/quickjs-go"
)

// Store 是插件 storage 的落盘实现，和宿主共用同一份 storage.json。
type Store struct {
	mu     sync.Mutex
	path   string
	data   map[string]json.RawMessage
	dirty  bool
	timer  *time.Timer
	onSave func(error)
}

// NewStore 读取（或新建）storage.json。
func NewStore(path string) (*Store, error) {
	s := &Store{path: path, data: map[string]json.RawMessage{}}
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return s, nil
		}
		return nil, err
	}
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &s.data); err != nil {
			// 文件坏了就按空处理，不要让控制台起不来
			s.data = map[string]json.RawMessage{}
		}
	}
	return s, nil
}

// Get 返回原始 JSON 值。
func (s *Store) Get(key string) (json.RawMessage, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	v, ok := s.data[key]
	return v, ok
}

// Set 写入并安排落盘。
func (s *Store) Set(key string, value json.RawMessage) {
	s.mu.Lock()
	s.data[key] = value
	s.dirty = true
	s.mu.Unlock()
	s.schedule()
}

// Delete 删除并安排落盘。
func (s *Store) Delete(key string) {
	s.mu.Lock()
	delete(s.data, key)
	s.dirty = true
	s.mu.Unlock()
	s.schedule()
}

// Keys 返回全部键。
func (s *Store) Keys() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, 0, len(s.data))
	for k := range s.data {
		out = append(out, k)
	}
	return out
}

// Dump 返回整个存储的快照。
func (s *Store) Dump() map[string]json.RawMessage {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make(map[string]json.RawMessage, len(s.data))
	for k, v := range s.data {
		out[k] = v
	}
	return out
}

// schedule 合并 200ms 内的写入，避免扫码轮询时每秒落盘十几次。
func (s *Store) schedule() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.timer != nil {
		return
	}
	s.timer = time.AfterFunc(200*time.Millisecond, func() {
		s.mu.Lock()
		s.timer = nil
		s.mu.Unlock()
		if err := s.Flush(); err != nil && s.onSave != nil {
			s.onSave(err)
		}
	})
}

// Flush 立即落盘。
func (s *Store) Flush() error {
	s.mu.Lock()
	if !s.dirty {
		s.mu.Unlock()
		return nil
	}
	payload, err := json.Marshal(s.data)
	s.dirty = false
	s.mu.Unlock()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(s.path, payload, 0o644)
}

// Options 是搭 host 环境需要的全部外部依赖。
type Options struct {
	Store       *Store
	PluginDir   string
	DataDir     string
	Platform    string // windows / darwin / linux
	Arch        string // amd64 / arm64
	Language    string
	GetSettings func() map[string]string
	OnPrompt    func(qr, text string)
	OnLog       func(string)
	Fetch       func(method, url string, headers map[string]string, body string) (int, string)
	Spawn       func(command string, args []string) (Proc, error)
}

// Proc 是 host.spawn 返回的进程句柄。
type Proc interface {
	Write(text string) error
	CloseStdin()
	ReadLine() (string, bool)
	Wait() int
	ErrorOutput() string
	Kill()
}

// Install 把 host 和 fetch 挂到 QuickJS 的全局对象上。
func Install(ctx *quickjs.Context, opt Options) error {
	if opt.OnLog == nil {
		opt.OnLog = func(string) {}
	}
	if opt.GetSettings == nil {
		opt.GetSettings = func() map[string]string { return map[string]string{} }
	}

	host := ctx.NewObject()
	ctx.Globals().Set("host", host)

	host.Set("platform", ctx.String(opt.Platform))
	host.Set("arch", ctx.String(opt.Arch))
	host.Set("dir", ctx.String(opt.PluginDir))
	host.Set("dataDir", ctx.String(opt.DataDir))

	// host.t：插件里用来取翻译，控制台不做翻译，原样返回
	host.Set("t", ctx.Function(func(c *quickjs.Context, this *quickjs.Value, args []*quickjs.Value) *quickjs.Value {
		if len(args) < 1 {
			return c.String("")
		}
		return c.String(args[0].String())
	}))
	host.Set("language", ctx.Function(func(c *quickjs.Context, this *quickjs.Value, args []*quickjs.Value) *quickjs.Value {
		return c.String(opt.Language)
	}))

	// host.setting：设置项一律是字符串
	host.Set("setting", ctx.Function(func(c *quickjs.Context, this *quickjs.Value, args []*quickjs.Value) *quickjs.Value {
		if len(args) < 1 {
			return c.String("")
		}
		return c.String(opt.GetSettings()[args[0].String()])
	}))

	// host.storage：值以 JSON 文本往返，避免跨语言类型问题
	storage := ctx.NewObject()
	storage.Set("get", ctx.Function(func(c *quickjs.Context, this *quickjs.Value, args []*quickjs.Value) *quickjs.Value {
		if len(args) < 1 {
			return c.Undefined()
		}
		raw, ok := opt.Store.Get(args[0].String())
		if !ok {
			return c.Undefined()
		}
		// 用 JSON.parse 而不是把文本拼进代码里求值：
		// storage 里可能有几十 KB 的音源源码，拼成字面量会让解析器爆栈。
		v := c.Eval("JSON.parse(" + jsString(string(raw)) + ")")
		if v == nil || v.IsException() {
			return c.Undefined()
		}
		return v
	}))
	storage.Set("set", ctx.Function(func(c *quickjs.Context, this *quickjs.Value, args []*quickjs.Value) *quickjs.Value {
		if len(args) < 2 {
			return c.Undefined()
		}
		key := args[0].String()
		jsonText := args[1].JSONStringify()
		if jsonText == "" {
			return c.Undefined()
		}
		opt.Store.Set(key, json.RawMessage(jsonText))
		return c.Undefined()
	}))
	storage.Set("remove", ctx.Function(func(c *quickjs.Context, this *quickjs.Value, args []*quickjs.Value) *quickjs.Value {
		if len(args) >= 1 {
			opt.Store.Delete(args[0].String())
		}
		return c.Undefined()
	}))
	host.Set("storage", storage)

	// host.crypto：md5 和 AES-128-ECB
	cryptoObj := ctx.NewObject()
	cryptoObj.Set("md5", ctx.Function(func(c *quickjs.Context, this *quickjs.Value, args []*quickjs.Value) *quickjs.Value {
		if len(args) < 1 {
			return c.String("")
		}
		return c.String(md5Hex(args[0].String()))
	}))
	cryptoObj.Set("aesEcbEncrypt", ctx.Function(func(c *quickjs.Context, this *quickjs.Value, args []*quickjs.Value) *quickjs.Value {
		if len(args) < 2 {
			return c.String("")
		}
		out, err := aesEcbHex(args[0].String(), args[1].String())
		if err != nil {
			return c.String("")
		}
		return c.String(hex.EncodeToString([]byte(out)))
	}))
	host.Set("crypto", cryptoObj)

	// host.signInPrompt：把二维码推给前端轮询接口
	host.Set("signInPrompt", ctx.Function(func(c *quickjs.Context, this *quickjs.Value, args []*quickjs.Value) *quickjs.Value {
		if len(args) >= 1 && opt.OnPrompt != nil {
			v := args[0]
			qr := ""
			text := ""
			if q := v.Get("qr"); q != nil && !q.IsUndefined() {
				qr = q.String()
				q.Free()
			}
			if t := v.Get("text"); t != nil && !t.IsUndefined() {
				text = t.String()
				t.Free()
			}
			opt.OnPrompt(qr, text)
		}
		return c.Undefined()
	}))

	host.Set("openURL", ctx.Function(func(c *quickjs.Context, this *quickjs.Value, args []*quickjs.Value) *quickjs.Value {
		if len(args) >= 1 {
			opt.OnLog("openURL: " + args[0].String())
		}
		return c.Undefined()
	}))

	// console：QuickJS 没有内置，插件里到处在用，必须补上
	consoleObj := ctx.NewObject()
	for _, level := range []string{"log", "warn", "error", "info", "debug"} {
		lv := level
		consoleObj.Set(lv, ctx.Function(func(c *quickjs.Context, this *quickjs.Value, args []*quickjs.Value) *quickjs.Value {
			parts := make([]string, 0, len(args))
			for _, a := range args {
				if a != nil {
					parts = append(parts, a.String())
				}
			}
			opt.OnLog("[" + lv + "] " + strings.Join(parts, " "))
			return c.Undefined()
		}))
	}
	ctx.Globals().Set("console", consoleObj)

	// fetch：同步桥接（Go 侧发请求，结果回填）
	ctx.Globals().Set("__hostFetch", ctx.Function(func(c *quickjs.Context, this *quickjs.Value, args []*quickjs.Value) *quickjs.Value {
		if len(args) < 4 || opt.Fetch == nil {
			return c.String(JSONOf(map[string]any{"ok": false, "error": "no fetch"}))
		}
		method := args[0].String()
		url := args[1].String()
		headersJSON := args[2].String()
		body := args[3].String()
		headers := map[string]string{}
		_ = json.Unmarshal([]byte(headersJSON), &headers)
		status, text := opt.Fetch(method, url, headers, body)
		return c.String(JSONOf(map[string]any{"ok": true, "status": status, "body": text}))
	}))

	// 用 JS 包一层，做出插件期待的 Response 形状
	shim := `
globalThis.fetch = async function (url, options) {
  options = options || {};
  const headers = options.headers || {};
  const flat = {};
  if (headers && typeof headers.forEach === 'function') {
    headers.forEach((v, k) => { flat[k] = v; });
  } else {
    Object.assign(flat, headers);
  }
  const body = options.body == null ? '' : String(options.body);
  const raw = globalThis.__hostFetch(String(url), String(options.method || 'GET'), JSON.stringify(flat), body);
  const res = JSON.parse(raw);
  if (!res.ok) throw new Error(res.error || 'fetch failed');
  return {
    ok: res.status >= 200 && res.status < 300,
    status: res.status,
    headers: { get: (k) => flat[k.toLowerCase()] || null },
    text: async () => res.body,
    json: async () => JSON.parse(res.body),
  };
};
`
	v := ctx.Eval(shim)
	if v.IsException() {
		msg := ctx.Exception()
		v.Free()
		return fmt.Errorf("安装 fetch 垫片: %s", msg)
	}
	v.Free()

	return nil
}

// jsString 把一个 Go 字符串转成安全的 JS 字符串字面量。
func jsString(s string) string {
	var sb strings.Builder
	sb.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			sb.WriteString("\\\"")
		case '\\':
			sb.WriteString("\\\\")
		case '\n':
			sb.WriteString("\\n")
		case '\r':
			sb.WriteString("\\r")
		case '\t':
			sb.WriteString("\\t")
		default:
			if r < 0x20 {
				sb.WriteString(fmt.Sprintf("\\u%04x", r))
			} else {
				sb.WriteRune(r)
			}
		}
	}
	sb.WriteByte('"')
	return sb.String()
}

// JSONOf 把值序列化成 JSON 文本，失败时返回 {}。
func JSONOf(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return "{}"
	}
	return string(b)
}

// TrimSlash 归一化路径。
func TrimSlash(p string) string {
	return strings.TrimSuffix(filepath.ToSlash(p), "/")
}
