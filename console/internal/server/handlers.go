package server

import (
	"net/http"
	"strings"
)

// handleIndex 返回前端页面。
func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/" && r.URL.Path != "/index.html" {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": "not found"})
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = w.Write(s.opt.IndexHTML)
}

// handleStatus 汇总账号、音源、设置、版本，前端一次拿全。
func (s *Server) handleStatus(w http.ResponseWriter, r *http.Request) {
	settings := s.opt.Settings.Read()
	active := settings["activeProvider"]
	if active == "" {
		active = "netease"
	}

	var out []map[string]any
	for _, name := range Providers {
		item := map[string]any{
			"name":   name,
			"label":  labelOf(name),
			"active": name == active,
		}
		acct, err := s.opt.Runtime.Account(name)
		if err != nil {
			item["error"] = err.Error()
		}
		if acct != nil {
			item["loggedIn"] = true
			item["account"] = acct
		} else {
			item["loggedIn"] = false
		}
		if name == "qq" {
			list, err := s.opt.Runtime.Accounts(name)
			if err != nil {
				// 把错误带到前端，不要静默吞掉——否则界面只是空列表，看不出原因
				item["accountsError"] = err.Error()
				if s.opt.Log != nil {
					s.opt.Log("accounts(" + name + "): " + err.Error())
				}
			} else {
				item["accounts"] = list
			}
		}
		item["login"] = s.states[name]
		if p := s.prompts[name]; p != nil {
			item["prompt"] = p
		}
		out = append(out, item)
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"providers":      out,
		"settings":       settings,
		"activeProvider": active,
		"version":        s.opt.Version,
	})
}

func labelOf(name string) string {
	switch name {
	case "netease":
		return "网易云音乐"
	case "qq":
		return "QQ 音乐"
	}
	return name
}

func (s *Server) handleSettings(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "需要 POST"})
		return
	}
	var patch map[string]string
	if err := readJSON(r, &patch); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	next := s.opt.Settings.Read()
	for k, v := range patch {
		next[k] = v
	}
	if err := s.opt.Settings.Write(next); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "settings": next})
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "需要 POST"})
		return
	}
	var body struct {
		Provider string `json:"provider"`
	}
	if err := readJSON(r, &body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	if !isProvider(body.Provider) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "未知音源"})
		return
	}

	s.active = body.Provider
	delete(s.prompts, body.Provider)
	s.states[body.Provider] = loginState{Status: "pending", Message: "正在获取二维码…"}

	if err := s.opt.Runtime.SignIn(body.Provider); err != nil {
		s.states[body.Provider] = loginState{Status: "error", Message: err.Error()}
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	// 登录是长任务，上面的 SignIn 只负责启动；结果通过状态轮询拿
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "started": true})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "需要 POST"})
		return
	}
	var body struct {
		Provider string `json:"provider"`
	}
	if err := readJSON(r, &body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	if !isProvider(body.Provider) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "未知音源"})
		return
	}
	if err := s.opt.Runtime.SignOut(body.Provider); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	s.states[body.Provider] = loginState{Status: "idle", Message: "已退出"}
	delete(s.prompts, body.Provider)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (s *Server) handleLoginCookie(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "需要 POST"})
		return
	}
	var body struct {
		Uin       string `json:"uin"`
		Musickey  string `json:"musickey"`
		LoginType string `json:"loginType"`
	}
	if err := readJSON(r, &body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	acct, err := s.opt.Runtime.SignInByCookie(body.Uin, body.Musickey, body.LoginType)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "account": acct})
}

func (s *Server) handleCapabilities(w http.ResponseWriter, r *http.Request) {
	probe, err := s.opt.Runtime.Capabilities()
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"probe": map[string]any{"error": err.Error()}, "provider": false})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"probe": probe, "provider": true})
}

func (s *Server) handleSourcesList(w http.ResponseWriter, r *http.Request) {
	list, err := s.opt.Runtime.ListSources()
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"scripts": []any{}})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"scripts": list})
}

func (s *Server) handleSourcesImport(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "需要 POST"})
		return
	}
	var body struct {
		Name   string `json:"name"`
		Source string `json:"source"`
	}
	if err := readJSON(r, &body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	info, err := s.opt.Runtime.ImportSource(body.Name, body.Source)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	list, _ := s.opt.Runtime.ListSources()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "info": info, "scripts": list})
}

func (s *Server) handleSourcesImportURL(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "需要 POST"})
		return
	}
	var body struct {
		Name string `json:"name"`
		URL  string `json:"url"`
	}
	if err := readJSON(r, &body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	info, err := s.opt.Runtime.ImportSourceFromURL(body.Name, body.URL)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	list, _ := s.opt.Runtime.ListSources()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "info": info, "scripts": list})
}

func (s *Server) handleSourcesReorder(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "需要 POST"})
		return
	}
	var body struct {
		Names []string `json:"names"`
	}
	if err := readJSON(r, &body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	list, err := s.opt.Runtime.ReorderSources(body.Names)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "scripts": list})
}

func (s *Server) handleSourcesRemove(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "需要 POST"})
		return
	}
	var body struct {
		Name string `json:"name"`
	}
	if err := readJSON(r, &body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	list, err := s.opt.Runtime.RemoveSource(body.Name)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "scripts": list})
}

func (s *Server) handleAccounts(w http.ResponseWriter, r *http.Request) {
	list, err := s.opt.Runtime.Accounts("qq")
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"accounts": []any{}, "loginMode": "wechat", "error": err.Error()})
		return
	}
	mode := s.opt.Settings.Read()["qq:loginMode"]
	if mode == "" {
		mode = "wechat"
	}
	writeJSON(w, http.StatusOK, map[string]any{"accounts": list, "loginMode": mode})
}

func (s *Server) handleAccountsSwitch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "需要 POST"})
		return
	}
	var body struct {
		ID string `json:"id"`
	}
	if err := readJSON(r, &body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	list, err := s.opt.Runtime.SwitchAccount(body.ID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	// 切了 QQ 账号，当前音源也应该是 qq，插件靠这个决定首页显示
	next := s.opt.Settings.Read()
	next["activeProvider"] = "qq"
	_ = s.opt.Settings.Write(next)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "accounts": list})
}

func (s *Server) handleAccountsRemove(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "需要 POST"})
		return
	}
	var body struct {
		ID string `json:"id"`
	}
	if err := readJSON(r, &body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	list, err := s.opt.Runtime.RemoveAccount(body.ID)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "accounts": list})
}

func (s *Server) handleActiveProvider(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "需要 POST"})
		return
	}
	var body struct {
		Provider string `json:"provider"`
	}
	if err := readJSON(r, &body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	if !isProvider(body.Provider) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "未知音源"})
		return
	}
	next := s.opt.Settings.Read()
	next["activeProvider"] = body.Provider
	if err := s.opt.Settings.Write(next); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "provider": body.Provider})
}

func (s *Server) handleLoginMode(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "需要 POST"})
		return
	}
	var body struct {
		Mode string `json:"mode"`
	}
	if err := readJSON(r, &body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	if body.Mode != "wechat" && body.Mode != "qq" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "未知登录方式"})
		return
	}
	next := s.opt.Settings.Read()
	next["qq:loginMode"] = body.Mode
	if err := s.opt.Settings.Write(next); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "mode": body.Mode})
}

func (s *Server) handlePrompt(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("provider")
	if name == "" {
		name = "netease"
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"prompt": s.prompts[name],
		"login":  s.states[name],
	})
}

func (s *Server) handleCancel(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "需要 POST"})
		return
	}
	var body struct {
		Provider string `json:"provider"`
	}
	if err := readJSON(r, &body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	if isProvider(body.Provider) {
		s.states[body.Provider] = loginState{Status: "idle", Message: "已取消"}
		delete(s.prompts, body.Provider)
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func isProvider(name string) bool {
	return strings.Contains(" netease qq ", " "+name+" ")
}
