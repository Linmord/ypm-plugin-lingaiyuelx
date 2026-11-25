package jsrt

import "fmt"

// probeCode 检查 Promise 是否已经落定。
const probeCode = `(function(){
  if (globalThis.__perr) { return "err:" + globalThis.__perr; }
  const p = globalThis.__p;
  if (!p || typeof p.then !== "function") {
    globalThis.__pres = p === undefined ? null : p;
    return "done";
  }
  if (globalThis.__pdone === true) { return "done"; }
  return "pending";
})()`

// hookCode 给 Promise 挂 then，把结果写回全局。
const hookCode = `(function(){
  const p = globalThis.__p;
  if (!p || typeof p.then !== "function") { return "noop"; }
  if (globalThis.__hooked) { return "hooked"; }
  globalThis.__hooked = true;
  p.then(
    (v) => { globalThis.__pres = v; globalThis.__pdone = true; },
    (e) => { globalThis.__perr = String(e && e.message ? e.message : e); }
  );
  return "hooked";
})()`

// settle 反复执行微任务，直到 Promise 落定。
//
// 每次 Eval 都回到 JS 侧跑一轮 then 回调，fetch 的 Go 回调也在这时执行。
// 这样就不需要在 cgo 栈里嵌套 Go 调用（那会导致段错误）。
func (r *Runtime) settle(st *state, rel, fn string) error {
	const maxRounds = 3000
	for i := 0; i < maxRounds; i++ {
		probe := st.ctx.Eval(probeCode)
		if probe == nil || probe.IsException() {
			if probe != nil {
				probe.Free()
			}
			return fmt.Errorf("%s.%s 探测状态失败", rel, fn)
		}
		stt := probe.String()
		probe.Free()

		if stt == "done" {
			return nil
		}
		if len(stt) > 4 && stt[:4] == "err:" {
			return fmt.Errorf("%s", stt[4:])
		}

		step := st.ctx.Eval(hookCode)
		if step != nil {
			step.Free()
		}

		// 关键：Eval 只跑同步代码，Promise 的 then 回调是微任务，
		// 必须靠 LoopOnce 里的 JS_ExecutePendingJob 才会执行。
		// 不调这一步，fetch 的 await 永远停在 pending。
		st.ctx.LoopOnce()
	}
	return fmt.Errorf("%s.%s 等待异步结果超时", rel, fn)
}
