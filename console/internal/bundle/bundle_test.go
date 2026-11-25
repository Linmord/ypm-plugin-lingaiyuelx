package bundle

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func pluginDir(t *testing.T) string {
	t.Helper()
	dir := os.Getenv("PLUGIN_DIR")
	if dir == "" {
		dir = filepath.Join(os.Getenv("APPDATA"), "YesPlayMusic", "plugins", "multisource")
	}
	if _, err := os.Stat(filepath.Join(dir, "plugin.json")); err != nil {
		t.Skip("找不到插件目录，跳过：" + dir)
	}
	return dir
}

func TestStrip(t *testing.T) {
	b := New(".")
	cases := []struct{ in, want, notWant string }{
		{"import { a } from './x.js';\nexport function f() {}", "function f()", "import"},
		{"export const X = 1;", "const X = 1;", "export"},
		{"export async function g() {}", "async function g()", "export"},
		{"import './side.js';\nlet y = 2;", "let y = 2;", "import"},
	}
	for _, c := range cases {
		got := b.Strip(c.in)
		if !strings.Contains(got, c.want) {
			t.Errorf("strip(%q) 缺少 %q，得到 %q", c.in, c.want, got)
		}
		if strings.Contains(got, c.notWant) {
			t.Errorf("strip(%q) 仍含 %q，得到 %q", c.in, c.notWant, got)
		}
	}
}

func TestNames(t *testing.T) {
	src := "export function a(){}\nexport const b = 1;\nexport async function c(){}"
	got := Names(src)
	want := []string{"a", "b", "c"}
	if len(got) != len(want) {
		t.Fatalf("Names = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("Names[%d] = %q, want %q", i, got[i], want[i])
		}
	}
}

func TestBuildRealModule(t *testing.T) {
	root := pluginDir(t)
	b := New(root)
	res, err := b.Build("shared/accounts.js")
	if err != nil {
		t.Fatalf("打包失败: %v", err)
	}
	if strings.Contains(res.Code, "import ") {
		t.Errorf("产物里仍有 import:\n%s", res.Code[:min(400, len(res.Code))])
	}
	if strings.Contains(res.Code, "export ") {
		t.Errorf("产物里仍有 export")
	}
	// accounts.js 依赖 storage.js，顺序上应该在前面
	if len(res.Order) < 2 {
		t.Fatalf("依赖没展开，Order = %v", res.Order)
	}
	if res.Order[len(res.Order)-1] != "shared/accounts.js" {
		t.Errorf("入口应最后，Order = %v", res.Order)
	}
	t.Logf("依赖顺序: %v", res.Order)
	if len(res.Warnings) > 0 {
		t.Logf("警告: %v", res.Warnings)
	}
}

func TestBuildComplexModule(t *testing.T) {
	root := pluginDir(t)
	b := New(root)
	res, err := b.Build("providers/qq/api.js")
	if err != nil {
		t.Fatalf("打包失败: %v", err)
	}
	t.Logf("依赖 %d 个: %v", len(res.Order), res.Order)
	if len(res.Warnings) > 0 {
		t.Logf("警告: %v", res.Warnings)
	}
	// 不能有残留语法
	for _, bad := range []string{"import ", "export "} {
		if strings.Contains(res.Code, bad) {
			t.Errorf("产物含 %q", bad)
		}
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
