package jsrt_test

import (
	"os"
	"path/filepath"
	"testing"

	"ypm-console/internal/jsrt"
)

func pluginDirs(t *testing.T) (string, string) {
	t.Helper()
	root := os.Getenv("APPDATA")
	plugin := filepath.Join(root, "YesPlayMusic", "plugins", "multisource")
	data := t.TempDir()
	if _, err := os.Stat(filepath.Join(plugin, "plugin.json")); err != nil {
		t.Skip("找不到插件")
	}
	return plugin, data
}

func TestNewRuntime(t *testing.T) {
	plugin, data := pluginDirs(t)
	rt, err := jsrt.New(plugin, data, jsrt.Hooks{
		GetSettings: func() map[string]string { return map[string]string{} },
		OnLog:       func(m string) { t.Log(m) },
	})
	if err != nil {
		t.Fatalf("建 runtime: %v", err)
	}
	defer rt.Close()
	t.Log("runtime 创建成功")
}

func TestAccountNoLogin(t *testing.T) {
	plugin, data := pluginDirs(t)
	rt, err := jsrt.New(plugin, data, jsrt.Hooks{
		GetSettings: func() map[string]string { return map[string]string{} },
		OnLog:       func(m string) { t.Log(m) },
	})
	if err != nil {
		t.Fatal(err)
	}
	defer rt.Close()

	for _, name := range []string{"netease", "qq"} {
		acct, err := rt.Account(name)
		if err != nil {
			t.Logf("%s: 错误 %v", name, err)
			continue
		}
		if acct == nil {
			t.Logf("%s: 未登录", name)
		} else {
			t.Logf("%s: %v", name, acct["name"])
		}
	}
}
