// Package jsrt 用 QuickJS 跑插件自己的模块，供 HTTP 层调用。
//
// 关键约束：QuickJS 的 JSRuntime 绑定在创建它的那个 OS 线程上。
// 所以整个上下文（创建、加载、调用）都必须在同一个线程上完成，
// 由 worker goroutine 统一持有，调用方排队进来。
package jsrt

import (
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"github.com/buke/quickjs-go"

	"ypm-console/internal/bundle"
	"ypm-console/internal/hostjs"
)

// Hooks 是 JS 侧回调 HTTP 层的接口。
type Hooks struct {
	OnPrompt    func(provider, qr, text string)
	OnStatus    func(provider, status, message string)
	OnLog       func(string)
	GetSettings func() map[string]string
}

// Runtime 持有 QuickJS 上下文。
type Runtime struct {
	work      *worker
	plugin    string
	dataDir   string
	store     *hostjs.Store
	hooks     Hooks
	mu        sync.Mutex
	closed    bool
	loggingIn string // 正在登录的音源，用于标注 signInPrompt 的归属
	st        *state
}

// state 是只属于 worker 线程的运行时状态。
type state struct {
	rt       *quickjs.Runtime
	ctx      *quickjs.Context
	loaded   map[string]bool
	modReady bool
}

// New 创建运行时。
//
// 注意：QuickJS 上下文在 worker 线程上创建，不是在这里。
// New 只负责准备 store 和 hooks，真正的初始化在第一次调用时懒执行。
func New(pluginDir, dataDir string, hooks Hooks) (*Runtime, error) {
	if hooks.OnLog == nil {
		hooks.OnLog = func(string) {}
	}
	if hooks.GetSettings == nil {
		hooks.GetSettings = func() map[string]string { return map[string]string{} }
	}

	store, err := hostjs.NewStore(filepath.Join(dataDir, "storage.json"))
	if err != nil {
		return nil, fmt.Errorf("读取 storage.json: %w", err)
	}

	SetFetchLogger(hooks.OnLog)
	r := &Runtime{
		work:    newWorker(),
		plugin:  pluginDir,
		dataDir: dataDir,
		store:   store,
		hooks:   hooks,
	}
	return r, nil
}

// ensure 在 worker 线程上初始化 QuickJS，返回该线程的运行时状态。
func (r *Runtime) ensure() (*state, error) {
	if r.st != nil {
		return r.st, nil
	}
	rt := quickjs.NewRuntime(
		quickjs.WithMemoryLimit(256<<20),
		quickjs.WithMaxStackSize(8<<20),
	)
	ctx := rt.NewContext()

	err := hostjs.Install(ctx, hostjs.Options{
		Store:       r.store,
		PluginDir:   r.plugin,
		DataDir:     r.dataDir,
		Platform:    "windows",
		Arch:        "amd64",
		Language:    "zh-CN",
		GetSettings: r.hooks.GetSettings,
		OnPrompt: func(qr, text string) {
			if r.hooks.OnPrompt != nil {
				// 用「当前正在登录的音源」标注二维码归属。
				// 不能靠 HTTP 层的 s.active：那是共享状态，两个音源同时登录会串。
				r.mu.Lock()
				who := r.loggingIn
				r.mu.Unlock()
				r.hooks.OnPrompt(who, qr, text)
			}
		},
		OnLog: r.hooks.OnLog,
		Fetch: fetchSync,
	})
	if err != nil {
		ctx.Close()
		rt.Close()
		return nil, fmt.Errorf("安装 host: %w", err)
	}

	// Go 侧回调挂进 JS
	ctx.Globals().Set("__hostPrompt", ctx.Function(func(c *quickjs.Context, this *quickjs.Value, args []*quickjs.Value) *quickjs.Value {
		if len(args) >= 3 && r.hooks.OnPrompt != nil {
			r.hooks.OnPrompt(args[0].String(), args[1].String(), args[2].String())
		}
		return c.Undefined()
	}))
	ctx.Globals().Set("__hostStatus", ctx.Function(func(c *quickjs.Context, this *quickjs.Value, args []*quickjs.Value) *quickjs.Value {
		if len(args) >= 3 && r.hooks.OnStatus != nil {
			r.hooks.OnStatus(args[0].String(), args[1].String(), args[2].String())
		}
		return c.Undefined()
	}))

	r.st = &state{rt: rt, ctx: ctx, loaded: map[string]bool{}}
	return r.st, nil
}

// load 打包并求值一个插件模块（只在 worker 线程上调用）。
func (r *Runtime) load(st *state, rel string) error {
	if st.loaded[rel] {
		return nil
	}
	if !st.modReady {
		v := st.ctx.Eval("globalThis.__mod = globalThis.__mod || {};")
		if v != nil {
			if v.IsException() {
				msg := st.ctx.Exception()
				v.Free()
				return fmt.Errorf("初始化模块表: %s", msg)
			}
			v.Free()
		}
		st.modReady = true
	}

	b := bundle.New(r.plugin)
	res, err := b.BuildIncremental(rel, nil, st.loaded)
	if err != nil {
		return fmt.Errorf("打包 %s: %w", rel, err)
	}
	for _, w := range res.Warnings {
		r.hooks.OnLog("bundle: " + w)
	}
	if res.Code == "" {
		st.loaded[rel] = true
		return nil
	}
	v := st.ctx.Eval(res.Code)
	if v == nil {
		return fmt.Errorf("%s 求值没有返回值（代码 %d 字节）", rel, len(res.Code))
	}
	if v.IsException() {
		msg := st.ctx.Exception()
		v.Free()
		return fmt.Errorf("%s 求值失败: %s", rel, msg)
	}
	v.Free()
	for _, dep := range res.Order {
		st.loaded[dep] = true
	}
	st.loaded[rel] = true
	return nil
}

// Close 释放运行时。
func (r *Runtime) Close() {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return
	}
	r.closed = true
	r.mu.Unlock()

	// 在 worker 线程上关掉 QuickJS
	_, _ = r.work.do(func() (any, error) {
		if r.st != nil {
			_ = r.store.Flush()
			if r.st.ctx != nil {
				r.st.ctx.Close()
			}
			if r.st.rt != nil {
				r.st.rt.Close()
			}
			r.st = nil
		}
		return nil, nil
	})
	r.work.stop()
}

// Store 暴露存储。
func (r *Runtime) Store() *hostjs.Store { return r.store }

// LoadForTest 暴露给测试。
func (r *Runtime) LoadForTest(rel string) error {
	_, err := r.work.do(func() (any, error) {
		st, err := r.ensure()
		if err != nil {
			return nil, err
		}
		return nil, r.load(st, rel)
	})
	return err
}

var _ = os.Getenv
