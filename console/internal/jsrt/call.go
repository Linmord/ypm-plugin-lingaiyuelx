package jsrt

import (
	"encoding/json"
	"fmt"
)

// call 调用某个模块的导出函数，参数和返回值都走 JSON。
//
// 实际求值在 worker 线程上做（见 worker.go）：QuickJS 上下文只能被
// 创建它的那个 OS 线程使用，HTTP handler 并发调用必须排队。
func (r *Runtime) call(rel, fn string, args ...any) (json.RawMessage, error) {
	v, err := r.work.do(func() (any, error) {
		return r.callOnWorker(rel, fn, args...)
	})
	if err != nil {
		return nil, err
	}
	if v == nil {
		return nil, nil
	}
	return v.(json.RawMessage), nil
}

// callAsync 用于返回 Promise 的导出函数。
func (r *Runtime) callAsync(rel, fn string, args ...any) (json.RawMessage, error) {
	v, err := r.work.do(func() (any, error) {
		return r.callAsyncOnWorker(rel, fn, args...)
	})
	if err != nil {
		return nil, err
	}
	if v == nil {
		return nil, nil
	}
	return v.(json.RawMessage), nil
}

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

// callAsyncOnWorker 是 callAsync 的真实实现。
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
	code := fmt.Sprintf(
		"(function(){ const a = %s; const m = __mod[%q]; if (!m) return Promise.resolve(null); const f = m[%q]; if (typeof f !== 'function') return Promise.resolve(null); return Promise.resolve(f.apply(null, a)); })()",
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

	settled := st.ctx.Await(v)
	v.Free()
	if settled == nil {
		return nil, fmt.Errorf("%s.%s 没有返回结果", rel, fn)
	}
	if settled.IsException() {
		msg := st.ctx.Exception()
		settled.Free()
		return nil, fmt.Errorf("%v", msg)
	}

	st.ctx.Globals().Set("__settled", settled)
	settled.Free()
	outV := st.ctx.Eval("JSON.stringify(globalThis.__settled === undefined ? null : globalThis.__settled)")
	if outV == nil || outV.IsException() {
		if outV != nil {
			outV.Free()
		}
		st.ctx.Eval("delete globalThis.__settled").Free()
		return nil, fmt.Errorf("%s.%s 序列化结果失败", rel, fn)
	}
	out := outV.String()
	outV.Free()
	st.ctx.Eval("delete globalThis.__settled").Free()
	if out == "" || out == "null" || out == "undefined" {
		return nil, nil
	}
	return json.RawMessage(out), nil
}
