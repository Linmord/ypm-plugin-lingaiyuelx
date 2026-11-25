package jsrt

import (
	"encoding/json"
	"fmt"
)

// callOnWorker 是 call 的真实实现，只在 worker 线程上跑。
func (r *Runtime) callOnWorker(rel, fn string, args ...any) (json.RawMessage, error) {
	st, err := r.ensure()
	if err != nil {
		return nil, err
	}
	if err := r.load(st, rel); err != nil {
		return nil, err
	}

	argJSON, err := json.Marshal(args)
	if err != nil {
		return nil, err
	}
	code := fmt.Sprintf(
		"JSON.stringify((function(){ const a = %s; const m = __mod[%q];"+
			" if (!m) { globalThis.__diag = 'module missing: ' + %q; return null; }"+
			" const f = m[%q];"+
			" if (typeof f !== 'function') { globalThis.__diag = 'export missing: ' + %q + ' / exports=' + Object.keys(m).join(','); return null; }"+
			" globalThis.__diag = ''; return f.apply(null, a); })() || null)",
		string(argJSON), rel, rel, fn, fn)
	v := st.ctx.Eval(code)
	if v == nil {
		return nil, fmt.Errorf("%s.%s 求值没有返回值", rel, fn)
	}
	if v.IsException() {
		msg := st.ctx.Exception()
		v.Free()
		return nil, fmt.Errorf("%s.%s 异常: %v", rel, fn, msg)
	}
	out := v.String()
	v.Free()
	if diag := st.ctx.Eval("globalThis.__diag || ''"); diag != nil {
		if !diag.IsException() && diag.String() != "" {
			msg := diag.String()
			diag.Free()
			return nil, fmt.Errorf("%s", msg)
		}
		diag.Free()
	}
	if out == "" || out == "null" {
		return nil, nil
	}
	return json.RawMessage(out), nil
}

// callAsyncOnWorker 等到 Promise 落定再返回。
// 只用于「快」的异步函数；扫码登录这种长任务走 startAsync。
func (r *Runtime) callAsyncOnWorker(rel, fn string, args ...any) (json.RawMessage, error) {
	st, err := r.ensure()
	if err != nil {
		return nil, err
	}
	if err := r.load(st, rel); err != nil {
		return nil, err
	}

	argJSON, err := json.Marshal(args)
	if err != nil {
		return nil, err
	}

	st.ctx.Eval("globalThis.__p = undefined; globalThis.__pres = undefined; globalThis.__perr = null; globalThis.__pdone = false; globalThis.__hooked = false;").Free()

	code := fmt.Sprintf(
		"globalThis.__p = (function(){ const a = %s; const m = __mod[%q]; if (!m) return null; const f = m[%q]; if (typeof f !== 'function') return null; try { return f.apply(null, a); } catch (e) { globalThis.__perr = String(e && e.message ? e.message : e); return null; } })()",
		string(argJSON), rel, fn)
	v := st.ctx.Eval(code)
	if v == nil {
		return nil, fmt.Errorf("%s.%s 求值没有返回值", rel, fn)
	}
	if v.IsException() {
		msg := st.ctx.Exception()
		v.Free()
		return nil, fmt.Errorf("%s.%s 启动异常: %v", rel, fn, msg)
	}
	v.Free()

	if h := st.ctx.Eval(hookCode); h != nil {
		h.Free()
	}

	// 短任务：最多跑 3000 轮事件循环
	for i := 0; i < 3000; i++ {
		st.ctx.LoopOnce()

		if e := st.ctx.Eval("globalThis.__perr || ''"); e != nil {
			msg := e.String()
			e.Free()
			if msg != "" {
				return nil, fmt.Errorf("%s", msg)
			}
		}

		done := st.ctx.Eval("globalThis.__pdone === true")
		finished := done != nil && !done.IsException() && done.Bool()
		if done != nil {
			done.Free()
		}
		if finished {
			break
		}
	}

	outV := st.ctx.Eval("JSON.stringify(globalThis.__pres === undefined ? null : globalThis.__pres)")
	if outV == nil || outV.IsException() {
		if outV != nil {
			outV.Free()
		}
		return nil, fmt.Errorf("%s.%s 序列化结果失败", rel, fn)
	}
	out := outV.String()
	outV.Free()
	if out == "" || out == "null" || out == "undefined" {
		return nil, nil
	}
	return json.RawMessage(out), nil
}
