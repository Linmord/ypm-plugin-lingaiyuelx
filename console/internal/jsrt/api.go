package jsrt

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// Account 返回某音源当前登录的账号。
func (r *Runtime) Account(provider string) (map[string]any, error) {
	raw, err := r.callAsync(moduleOf(provider), "account")
	if err != nil {
		return nil, err
	}
	if raw == nil {
		return nil, nil
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	if len(out) == 0 {
		return nil, nil
	}
	return out, nil
}

// SignIn 启动扫码登录。插件里的 signIn 是长任务，这里放 goroutine 跑。
func (r *Runtime) SignIn(provider string) error {
	mod := moduleOf(provider)
	// 先确认模块能加载，加载失败立刻报错给前端
	if _, err := r.work.do(func() (any, error) {
		st, err := r.ensure()
		if err != nil {
			return nil, err
		}
		return nil, r.load(st, mod)
	}); err != nil {
		return err
	}

	go func() {
		defer func() {
			if rec := recover(); rec != nil {
				if r.hooks.OnStatus != nil {
					r.hooks.OnStatus(provider, "error", fmt.Sprint(rec))
				}
			}
		}()
		raw, err := r.callAsync(mod, "signIn")
		if err != nil {
			if r.hooks.OnStatus != nil {
				r.hooks.OnStatus(provider, "error", err.Error())
			}
			return
		}
		status := "idle"
		message := "已取消"
		if raw != nil && string(raw) != "null" {
			status = "done"
			message = "登录成功"
		}
		if r.hooks.OnStatus != nil {
			r.hooks.OnStatus(provider, status, message)
		}
	}()
	return nil
}

// SignOut 退出当前账号。
func (r *Runtime) SignOut(provider string) error {
	_, err := r.callAsync(moduleOf(provider), "signOut")
	return err
}

// SignInByCookie 用填进来的 cookie 直接登录（只 QQ 支持）。
func (r *Runtime) SignInByCookie(uin, musickey, loginType string) (map[string]any, error) {
	raw, err := r.callAsync("providers/qq/api.js", "signInByCookie", map[string]any{
		"uin":       uin,
		"musickey":  musickey,
		"loginType": loginType,
	})
	if err != nil {
		return nil, err
	}
	if raw == nil {
		return nil, fmt.Errorf("登录没有返回账号")
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Accounts 列出某音源已保存的全部账号。
func (r *Runtime) Accounts(provider string) ([]map[string]any, error) {
	if provider != "qq" {
		return nil, fmt.Errorf("该音源不支持多账号")
	}
	raw, err := r.call("providers/qq/api.js", "accounts_")
	if err != nil {
		return nil, err
	}
	if raw == nil {
		return []map[string]any{}, nil
	}
	var out []map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// SwitchAccount 切到指定账号。
func (r *Runtime) SwitchAccount(id string) ([]map[string]any, error) {
	if _, err := r.call("providers/qq/api.js", "switchAccount", id); err != nil {
		return nil, err
	}
	return r.Accounts("qq")
}

// RemoveAccount 删除指定账号。
func (r *Runtime) RemoveAccount(id string) ([]map[string]any, error) {
	if _, err := r.call("providers/qq/api.js", "removeAccount", id); err != nil {
		return nil, err
	}
	return r.Accounts("qq")
}

// ListSources 列出已导入的洛雪音源。
func (r *Runtime) ListSources() ([]map[string]any, error) {
	raw, err := r.call("index.js", "listSources")
	if err != nil {
		return nil, err
	}
	if raw == nil {
		return []map[string]any{}, nil
	}
	var out []map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ImportSource 从源码导入音源。
func (r *Runtime) ImportSource(name, source string) (map[string]any, error) {
	raw, err := r.call("index.js", "importSource", map[string]any{"name": name, "source": source})
	if err != nil {
		return nil, err
	}
	return decodeMap(raw)
}

// ImportSourceFromURL 从网络导入音源。
func (r *Runtime) ImportSourceFromURL(name, url string) (map[string]any, error) {
	raw, err := r.callAsync("index.js", "importSourceFromUrl", map[string]any{"name": name, "url": url})
	if err != nil {
		return nil, err
	}
	return decodeMap(raw)
}

// ReorderSources 调整音源顺序。
func (r *Runtime) ReorderSources(names []string) ([]map[string]any, error) {
	if _, err := r.call("index.js", "reorderSources", map[string]any{"names": names}); err != nil {
		return nil, err
	}
	return r.ListSources()
}

// RemoveSource 删除一个音源。
func (r *Runtime) RemoveSource(name string) ([]map[string]any, error) {
	if _, err := r.call("index.js", "removeSource", map[string]any{"name": name}); err != nil {
		return nil, err
	}
	return r.ListSources()
}

// Capabilities 探测运行环境：确认 QuickJS 能执行导入的脚本。
func (r *Runtime) Capabilities() (map[string]any, error) {
	out := map[string]any{
		"quickjs":  true,
		"platform": "windows",
	}
	raw, err := r.call("index.js", "probeCapabilities")
	if err != nil {
		out["error"] = err.Error()
		return out, nil
	}
	if raw != nil {
		var probe map[string]any
		if json.Unmarshal(raw, &probe) == nil {
			out["probe"] = probe
		}
	}
	return out, nil
}

// moduleOf 把音源名映射到模块路径。
func moduleOf(provider string) string {
	return "providers/" + provider + "/api.js"
}

func decodeMap(raw json.RawMessage) (map[string]any, error) {
	if raw == nil {
		return map[string]any{}, nil
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, err
	}
	return out, nil
}

var _ = strings.TrimSpace
var _ = time.Now
