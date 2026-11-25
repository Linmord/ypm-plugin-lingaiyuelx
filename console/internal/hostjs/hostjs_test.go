package hostjs_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/buke/quickjs-go"

	"ypm-console/internal/bundle"
	"ypm-console/internal/hostjs"
)

func pluginDir(t *testing.T) string {
	t.Helper()
	dir := os.Getenv("PLUGIN_DIR")
	if dir == "" {
		dir = filepath.Join(os.Getenv("APPDATA"), "YesPlayMusic", "plugins", "multisource")
	}
	if _, err := os.Stat(filepath.Join(dir, "plugin.json")); err != nil {
		t.Skip("找不到插件目录：" + dir)
	}
	return dir
}

func setup(t *testing.T) (*quickjs.Runtime, *quickjs.Context, *hostjs.Store, string) {
	t.Helper()
	dir := pluginDir(t)
	dataDir := t.TempDir()
	store, err := hostjs.NewStore(filepath.Join(dataDir, "storage.json"))
	if err != nil {
		t.Fatalf("建 store: %v", err)
	}

	rt := quickjs.NewRuntime(quickjs.WithMemoryLimit(64<<20), quickjs.WithExecuteTimeout(30))
	ctx := rt.NewContext()

	settings := map[string]string{"fallback": "true"}
	err = hostjs.Install(ctx, hostjs.Options{
		Store:       store,
		PluginDir:   dir,
		DataDir:     dataDir,
		Platform:    "windows",
		Arch:        "amd64",
		Language:    "zh-CN",
		GetSettings: func() map[string]string { return settings },
		OnPrompt:    func(qr, text string) {},
		OnLog:       func(string) {},
		Fetch: func(method, url string, headers map[string]string, body string) (int, string) {
			return 200, JSONCode()
		},
	})
	if err != nil {
		t.Fatalf("装 host: %v", err)
	}
	return rt, ctx, store, dir
}

// JSONCode 是一个最小响应体
func JSONCode() string { return `{"code":0}` }

func TestHostGlobals(t *testing.T) {
	rt, ctx, _, _ := setup(t)
	defer rt.Close()
	defer ctx.Close()

	v := ctx.Eval(`
		[typeof host, typeof host.storage.get, typeof host.crypto.md5, typeof host.setting, typeof fetch, host.platform].join(",")
	`)
	if v.IsException() {
		t.Fatalf("求值异常: %s", ctx.Exception())
	}
	got := v.String()
	v.Free()
	if !strings.HasPrefix(got, "object,function,function,function,function,") {
		t.Errorf("host 环境不完整: %s", got)
	}
	t.Logf("host 环境: %s", got)
}

func TestStorageRoundTrip(t *testing.T) {
	rt, ctx, store, _ := setup(t)
	defer rt.Close()
	defer ctx.Close()

	v := ctx.Eval(`
		host.storage.set("p:qq:session", { uin: "123", musickey: "abc" });
		const s = host.storage.get("p:qq:session");
		s.uin + "/" + s.musickey
	`)
	if v.IsException() {
		t.Fatalf("求值异常: %s", ctx.Exception())
	}
	got := v.String()
	v.Free()
	if got != "123/abc" {
		t.Errorf("往返结果 = %q, want 123/abc", got)
	}

	raw, ok := store.Get("p:qq:session")
	if !ok {
		t.Fatal("Go 侧读不到写入的值")
	}
	if !strings.Contains(string(raw), "musickey") {
		t.Errorf("落盘内容不对: %s", raw)
	}
}

func TestCryptoMatchesHost(t *testing.T) {
	rt, ctx, _, _ := setup(t)
	defer rt.Close()
	defer ctx.Close()

	v := ctx.Eval(`host.crypto.md5("hello")`)
	if v.IsException() {
		t.Fatalf("求值异常: %s", ctx.Exception())
	}
	got := v.String()
	v.Free()
	if got != "5d41402abc4b2a76b9719d911017c592" {
		t.Errorf("md5(hello) = %q", got)
	}
}

func TestRunRealPluginModule(t *testing.T) {
	rt, ctx, _, dir := setup(t)
	defer rt.Close()
	defer ctx.Close()

	b := bundle.New(dir)
	names := []string{"scoped", "list", "activeId", "upsert", "current"}
	res, err := b.BuildExports("shared/accounts.js", names)
	if err != nil {
		t.Fatalf("打包: %v", err)
	}
	t.Logf("依赖: %v", res.Order)
	if len(res.Warnings) > 0 {
		t.Logf("警告: %v", res.Warnings)
	}

	v := ctx.Eval(res.Code)
	if v.IsException() {
		t.Fatalf("模块求值异常: %s", ctx.Exception())
	}
	v.Free()

	out := ctx.Eval(`
		upsert("qq", { id: "test-1", name: "测试账号", credential: { uin: "test-1", musickey: "k" } });
		const c = current("qq");
		JSON.stringify({ id: c && c.id, name: c && c.name, total: list("qq").length })
	`)
	if out.IsException() {
		t.Fatalf("调用异常: %s", ctx.Exception())
	}
	got := out.String()
	out.Free()
	t.Logf("accounts.js 调用结果: %s", got)

	if !strings.Contains(got, "test-1") {
		t.Errorf("upsert 没生效: %s", got)
	}
	if !strings.Contains(got, `"total":1`) {
		t.Errorf("list 数量不对: %s", got)
	}
}

func TestRunQQApiModule(t *testing.T) {
	rt, ctx, _, dir := setup(t)
	defer rt.Close()
	defer ctx.Close()

	b := bundle.New(dir)
	res, err := b.BuildExports("providers/qq/api.js", nil)
	if err != nil {
		t.Fatalf("打包: %v", err)
	}
	t.Logf("依赖 %d 个", len(res.Order))

	v := ctx.Eval(res.Code)
	if v.IsException() {
		t.Fatalf("qq/api.js 求值异常: %s", ctx.Exception())
	}
	v.Free()
	t.Log("qq/api.js 在 Go + QuickJS 里加载成功")
}
