package jsrt

import (
	"encoding/json"
	"fmt"
	"time"
)

// call 调用某个模块的导出函数，参数和返回值都走 JSON。
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

// callAsync 用于返回 Promise 的导出函数，等到落定再返回结果。
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

// startAsync 启动一个长任务（比如扫码登录），立刻返回。
//
// 长任务会持续几分钟，期间要不断跑微任务和 setTimeout，
// 所以它必须占住 worker 线程自己驱动事件循环，不能走 settle 那种轮询。
func (r *Runtime) startAsync(rel, fn string, onDone func(json.RawMessage, error)) error {
	// 先确认模块能加载，加载失败立刻返回错误
	if _, err := r.work.do(func() (any, error) {
		st, err := r.ensure()
		if err != nil {
			return nil, err
		}
		return nil, r.load(st, rel)
	}); err != nil {
		return err
	}

	go func() {
		v, err := r.work.do(func() (any, error) {
			return r.runLongTask(rel, fn)
		})
		var out json.RawMessage
		if err == nil && v != nil {
			out = v.(json.RawMessage)
		}
		if onDone != nil {
			onDone(out, err)
		}
	}()
	return nil
}

// runLongTask 在 worker 线程上跑一个长 Promise，自己驱动事件循环直到落定。
func (r *Runtime) runLongTask(rel, fn string) (json.RawMessage, error) {
	st, err := r.ensure()
	if err != nil {
		return nil, err
	}
	if err := r.load(st, rel); err != nil {
		return nil, err
	}

	st.ctx.Eval("globalThis.__p = undefined; globalThis.__pres = undefined; globalThis.__perr = null; globalThis.__pdone = false; globalThis.__hooked = false;").Free()

	code := fmt.Sprintf(
		"globalThis.__p = (function(){ const m = __mod[%q]; if (!m) return null; const f = m[%q]; if (typeof f !== 'function') return null; try { return f(); } catch (e) { globalThis.__perr = String(e && e.message ? e.message : e); return null; } })()",
		rel, fn)
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

	// 挂 then
	if h := st.ctx.Eval(hookCode); h != nil {
		h.Free()
	}

	// 自己驱动事件循环：LoopOnce 会跑微任务和 setTimeout 回调。
	//
	// 不能靠「循环次数」判断超时 —— 没任务时 LoopOnce 立刻返回，
	// 几毫秒就能空转上万次。用墙钟时间。
	deadline := time.Now().Add(10 * time.Minute)
	for {
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

		if time.Now().After(deadline) {
			return nil, fmt.Errorf("%s.%s 登录超时", rel, fn)
		}

		// 给 setTimeout 一点时间：没有待执行任务时不要空转烧 CPU
		time.Sleep(20 * time.Millisecond)
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
